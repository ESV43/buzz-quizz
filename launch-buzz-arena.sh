#!/bin/bash
# Buzz Arena — single-click launcher
cd "$(dirname "$0")"
echo "=== Buzz Arena starting ==="
# free port if a previous run is stuck
fuser -k 3000/tcp 2>/dev/null
sleep 1
# show LAN IPs for phones
echo "LAN IPs:"
ip -4 addr show | grep -oP '(?<=inet\s)\d+\.\d+\.\d+\.\d+' | grep -v "127.0.0.1"
echo ""
echo "Host screen: http://localhost:3000/host.html"
echo "Players use: http://<LAN-IP>:3000/play.html?room=CODE (shown on host screen)"
echo ""
# open host page after 2s
(sleep 2 && xdg-open http://localhost:3000/host.html >/dev/null 2>&1 &) &
# run server (keeps window open on exit)
node server.js
echo ""
echo "--- server stopped. Press Enter to close ---"
read -r
