#!/bin/bash
# Grab the K2 Plus touchscreen as a PNG: re/tools/screenshot.sh [ip] [out.png]
# Wakes the panel with a synthetic tap only if the framebuffer is blank.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/../../deploy/local.env" ] && . "$HERE/../../deploy/local.env"
IP="${1:-${K2_IP:-}}"; OUT="${2:-screen-$(date +%H%M%S).png}"
[ -n "$IP" ] || { echo "printer IP needed: pass it, or set K2_IP in deploy/local.env (see local.env.example)" >&2; exit 2; }
scp -O -q -o BatchMode=yes "$HERE/tap.py" "root@$IP:/tmp/tap.py"
ssh -o BatchMode=yes "root@$IP" 'NZ=$(head -c 1536000 /dev/fb0 | tr -d "\000" | wc -c); [ "$NZ" -gt 1000 ] || { /usr/share/klippy-env/bin/python /tmp/tap.py 240 400; sleep 2; }; head -c 1536000 /dev/fb0 > /tmp/fb.raw'
scp -O -q -o BatchMode=yes "root@$IP:/tmp/fb.raw" /tmp/k2-fb.raw
convert -size 480x800 -depth 8 bgra:/tmp/k2-fb.raw -rotate 270 "$OUT"   # panel is portrait, UI is landscape
echo "$OUT"
