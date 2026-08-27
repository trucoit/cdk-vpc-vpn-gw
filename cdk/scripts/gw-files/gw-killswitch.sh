#!/bin/bash
set -e
LAN_IF=$(cat /etc/gw-lan-if)
iptables -F FORWARD
iptables -t nat -F POSTROUTING
iptables -t mangle -F FORWARD

iptables -P FORWARD DROP
if [ "${VpnEnabled}" = "true" ]; then
  # VPN router (fail-closed): forward only between the LAN NIC and the tunnel, and
  # NAT out tun0. When the tunnel is down, forwarded packets hit the DROP policy and
  # nothing falls back to the public path.
  # outbound, only traffic forwarded from the LAN NIC into the tunnel
  iptables -A FORWARD -i "$LAN_IF" -o tun0 -j ACCEPT
  # return, only established replies coming back from the tunnel to the LAN NIC
  iptables -A FORWARD -i tun0 -o "$LAN_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # NAT everything leaving the tunnel to the tunnel's address
  iptables -t nat -A POSTROUTING -o tun0 -j MASQUERADE
  # clamp MSS to the tunnel's lower path MTU so large TCP segments don't blackhole
  iptables -t mangle -A FORWARD -p tcp --syn -o tun0 -j TCPMSS --clamp-mss-to-pmtu
else
  # Plain NAT instance (NOT fail-closed): forward LAN traffic out the primary NIC to
  # the internet gateway and NAT it. Egress rides the public path, no tunnel.
  iptables -A FORWARD -i "$LAN_IF" -j ACCEPT
  iptables -A FORWARD -o "$LAN_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -t nat -A POSTROUTING -o "$LAN_IF" -j MASQUERADE
  iptables -t mangle -A FORWARD -p tcp --syn -o "$LAN_IF" -j TCPMSS --clamp-mss-to-pmtu
fi
# IPv6 has no forwarding path in either mode. Fail closed if a v6 CIDR appears.
ip6tables -P FORWARD DROP 2>/dev/null || true
