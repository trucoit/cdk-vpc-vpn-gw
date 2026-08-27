#!/bin/bash
# Don't judge health until boot finished (prevents a replacement loop).
[ -f /run/gw-boot-complete ] || exit 0

TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
          -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
IID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
          http://169.254.169.254/latest/meta-data/instance-id)
PUBIP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
          http://169.254.169.254/latest/meta-data/public-ipv4)
OK=1

# The private default route must still target THIS instance.
TARGET=$(aws ec2 describe-route-tables --region ${AWS::Region} \
  --route-table-ids ${PrivateRouteTable} \
  --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].InstanceId | [0]" \
  --output text 2>/dev/null)
[ "$TARGET" = "$IID" ] || OK=0

# When a VPN profile is configured, the tunnel must be up and egress must
# actually leave through it (exit IP differs from our own public IP / EIP).
if [ -f /run/gw-vpn-configured ]; then
  ip link show tun0 up >/dev/null 2>&1 || OK=0
  TUNIP=$(curl -s --interface tun0 --max-time 5 https://checkip.amazonaws.com 2>/dev/null)
  { [ -n "$TUNIP" ] && [ "$TUNIP" != "$PUBIP" ]; } || OK=0
fi

if [ "$OK" -ne 1 ]; then
  # One bounded self-heal attempt before escalating.
  systemctl restart openvpn-client@tun-vpn 2>/dev/null || true
  sleep 15
  RETRY=$(curl -s --interface tun0 --max-time 5 https://checkip.amazonaws.com 2>/dev/null)
  if ip link show tun0 up >/dev/null 2>&1 \
     && [ -n "$RETRY" ] && [ "$RETRY" != "$PUBIP" ] && [ "$TARGET" = "$IID" ]; then
    rm -f /run/gw-fail-count
    exit 0
  fi
  N=$(( $(cat /run/gw-fail-count 2>/dev/null || echo 0) + 1 ))
  echo "$N" > /run/gw-fail-count
  if [ "$N" -ge 5 ]; then
    aws autoscaling set-instance-health --region ${AWS::Region} \
      --instance-id "$IID" --health-status Unhealthy
  fi
else
  rm -f /run/gw-fail-count
fi
