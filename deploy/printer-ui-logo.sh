#!/bin/bash
# Put our icon in the K2 touchscreen's top bar (it replaces the camera icon's picture;
# tapping it still opens the camera view). The original is backed up on the printer and
# a firmware update restores stock files, so rerun this afterwards.
#   deploy/printer-ui-logo.sh [ip]            apply
#   deploy/printer-ui-logo.sh [ip] --revert   restore Creality's camera icon
set -euo pipefail
IP="${1:-192.168.13.215}"; MODE="${2:-apply}"
HERE="$(cd "$(dirname "$0")" && pwd)"
R=/etc/sysConfig/UIResource/K1; B=/mnt/UDISK/k2ctl/ui-backup; F=img_new_camera.png
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 "root@$IP")
if [ "$MODE" = "--revert" ]; then
  "${SSH[@]}" "set -e; [ -f $B/$F ] && cp $B/$F $R/$F && echo 'stock camera icon restored'; killall display-server"
else
  scp -O -q -o BatchMode=yes "$HERE/../assets/printer-topbar-k2ctl-39.png" "root@$IP:/tmp/$F"
  "${SSH[@]}" "set -e; mkdir -p $B; [ -f $B/$F ] || cp $R/$F $B/$F; cp /tmp/$F $R/$F; echo 'icon installed (backup in $B)'; killall display-server"
fi
# Monitor relaunches display-server within a few seconds.
for i in 1 2 3 4 5 6 7 8; do sleep 2; "${SSH[@]}" 'pidof display-server >/dev/null' && { echo "display-server back (pid $("${SSH[@]}" pidof display-server))"; exit 0; }; done
echo "display-server did not come back on its own; check: ssh root@$IP 'pidof display-server; logread | tail'" >&2; exit 1
