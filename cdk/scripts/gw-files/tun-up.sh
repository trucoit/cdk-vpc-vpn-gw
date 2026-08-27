#!/bin/bash
set -e
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
LAN_IF=$(cat /etc/gw-lan-if)
ip route replace default dev "$dev" table 100
ip rule add iif "$LAN_IF" lookup 100 priority 100 2>/dev/null || true
touch /run/gw-tunnel-up
