#!/bin/bash
# Deploy k2ctl to the K2 over SSH.
#   deploy/deploy.sh [printer-ip]      (default: K2_IP from deploy/local.env)
# Needs root SSH on the printer (Settings > Root account on the touchscreen shows
# the password). Export K2_ROOT_PW to avoid the prompts (uses sshpass).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/local.env" ] && . "$HERE/local.env"
IP="${1:-${K2_IP:-}}"
[ -n "$IP" ] || { echo "printer IP needed: pass it, or set K2_IP in deploy/local.env (see local.env.example)" >&2; exit 2; }
ROOT="$(cd "$HERE/.." && pwd)"
BIN="$ROOT/build/k2ctl-armv7"
[ -x "$BIN" ] || { echo "build first: make web arm" >&2; exit 1; }

SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8)
SCP=(scp -O -o StrictHostKeyChecking=accept-new)
if [ -n "${K2_ROOT_PW:-}" ]; then
  SSH=(sshpass -p "$K2_ROOT_PW" "${SSH[@]}")
  SCP=(sshpass -p "$K2_ROOT_PW" "${SCP[@]}")
fi

echo "==> $IP: preparing /mnt/UDISK/k2ctl"
"${SSH[@]}" "root@$IP" 'mkdir -p /mnt/UDISK/k2ctl && ([ -x /etc/init.d/k2ctl ] && /etc/init.d/k2ctl stop || true)'
echo "==> copying binary, profiles, init script"
"${SCP[@]}" "$BIN" "root@$IP:/mnt/UDISK/k2ctl/k2ctl.new"
"${SCP[@]}" "$HERE/profiles.json" "root@$IP:/mnt/UDISK/k2ctl/profiles.json"
"${SCP[@]}" "$HERE/k2ctl.init" "root@$IP:/etc/init.d/k2ctl"
"${SSH[@]}" "root@$IP" 'set -e; cd /mnt/UDISK/k2ctl; mv -f k2ctl.new k2ctl; chmod 755 k2ctl /etc/init.d/k2ctl; /etc/init.d/k2ctl enable; /etc/init.d/k2ctl start'
# The printer image has neither wget nor curl, so verify from this side.
sleep 2
if curl -s -m 8 "http://$IP:8085/api/version" >/dev/null; then
  echo "k2ctl is up on http://$IP:8085"
else
  echo "k2ctl did not answer on http://$IP:8085. Check: ssh root@$IP 'logread | tail -50'" >&2
  exit 1
fi
