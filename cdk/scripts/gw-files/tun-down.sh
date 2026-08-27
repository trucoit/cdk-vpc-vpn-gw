#!/bin/bash
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
LAN_IF=$(cat /etc/gw-lan-if)
ip rule del iif "$LAN_IF" lookup 100 priority 100 2>/dev/null || true
rm -f /run/gw-tunnel-up
