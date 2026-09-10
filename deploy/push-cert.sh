#!/bin/bash
# Copy the Let's Encrypt certificate for k2ctl.falcontechnix.com to the printer and
# restart k2ctl so it serves HTTPS on :443. Runs as root (certbot deploy hook, or
# `sudo deploy/push-cert.sh`); the SSH hop uses the desktop user's key.
set -euo pipefail
IP="${K2_IP:-192.168.13.215}"
NAME="${K2_CERT_NAME:-k2ctl.falcontechnix.com}"
SSH_USER="${K2_SSH_USER:-reaver}"
LIVE="/etc/letsencrypt/live/$NAME"
[ -r "$LIVE/fullchain.pem" ] || { echo "no certificate at $LIVE (run as root)" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cp "$LIVE/fullchain.pem" "$LIVE/privkey.pem" "$tmp/"; chown -R "$SSH_USER" "$tmp"; chmod 600 "$tmp"/*
run() { if [ "$(id -un)" = "$SSH_USER" ]; then "$@"; else runuser -u "$SSH_USER" -- "$@"; fi; }
run ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 "root@$IP" 'mkdir -p /mnt/UDISK/k2ctl/tls'
run scp -O -q -o BatchMode=yes "$tmp/fullchain.pem" "$tmp/privkey.pem" "root@$IP:/mnt/UDISK/k2ctl/tls/"
run ssh -o BatchMode=yes "root@$IP" 'chmod 600 /mnt/UDISK/k2ctl/tls/privkey.pem; /etc/init.d/k2ctl restart'
sleep 2
if curl -s -m 8 --resolve "$NAME:443:$IP" "https://$NAME/api/version" >/dev/null; then
  echo "k2ctl HTTPS is up: https://$NAME (cert expires $(openssl x509 -in "$LIVE/cert.pem" -noout -enddate | cut -d= -f2))"
else
  echo "k2ctl did not answer over HTTPS on $IP:443; check: ssh root@$IP 'logread | grep k2ctl | tail'" >&2; exit 1
fi
