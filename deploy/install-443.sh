#!/bin/bash
# Give k2ctl port 443 on the K2. Creality's web-server has 80/443/9999 compiled in, so a
# tiny LD_PRELOAD shim (deploy/bindshim) rewrites *its* bind() of 443 to 8443. The shim is
# loaded via /etc/ld.so.preload (only acts in a process named web-server), which survives
# Creality's Monitor watchdog relaunching /usr/bin/web-server by path. A wrapper script
# there does not work: Monitor treats it as a dead process and restart-loops. Idempotent; rerun
# after a firmware update. Revert: deploy/install-443.sh --revert
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/local.env" ] && . "$HERE/local.env"
IP="${K2_IP:-}"
[ -n "$IP" ] || { echo "printer IP needed: pass it, or set K2_IP in deploy/local.env (see local.env.example)" >&2; exit 2; }
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 "root@$IP")
SCP=(scp -O -q -o BatchMode=yes)
if [ "${1:-}" = "--revert" ]; then
  "${SSH[@]}" 'set -e; rm -f /etc/ld.so.preload; [ -x /mnt/UDISK/k2ctl/orig/web-server ] && ! head -c 2 /usr/bin/web-server | grep -q "^.ELF" && cp /mnt/UDISK/k2ctl/orig/web-server /usr/bin/web-server || true
    sed -i "s/-tls-listen :443 /-tls-listen :8443 /" /etc/init.d/k2ctl; /etc/init.d/k2ctl stop || true; killall web-server || true; sleep 8; /etc/init.d/k2ctl start; sleep 2; netstat -tln | grep -E ":(443|8443) "'
  echo "reverted: Creality on 443, k2ctl on 8443"; exit 0
fi
"${SCP[@]}" "$HERE/bindshim/bindshim.so" "root@$IP:/tmp/bindshim.so"
"${SSH[@]}" 'set -e
# never leave a wrapper in place (older versions of this script did)
if ! head -c 4 /usr/bin/web-server | grep -q "ELF"; then
  [ -x /mnt/UDISK/k2ctl/orig/web-server ] && cp /mnt/UDISK/k2ctl/orig/web-server /usr/bin/web-server
fi
cp /tmp/bindshim.so /lib/k2ctl-bindshim.so; chmod 644 /lib/k2ctl-bindshim.so; rm -f /tmp/bindshim.so
echo /lib/k2ctl-bindshim.so > /etc/ld.so.preload
sed -i "s/-tls-listen :8443 /-tls-listen :443 /" /etc/init.d/k2ctl
/etc/init.d/k2ctl stop || true
killall web-server || true            # Monitor relaunches /usr/bin/web-server; ld.so.preload adds the shim
for i in 1 2 3 4 5 6 7 8 9 10; do sleep 2; netstat -tln 2>/dev/null | grep -q ":8443 " && break; done
/etc/init.d/k2ctl start
sleep 2
echo "--- listeners:"; netstat -tlnp 2>/dev/null | grep -E ":(80|443|8443|9999|8085) "
echo "--- shim in web-server: $(tr "\0" "\n" < /proc/$(pidof web-server | awk "{print \$1}")/maps 2>/dev/null | grep -c bindshim) (>0 = loaded)"'
NAME="${K2_CERT_NAME:-}"   # the printer's hostname on your LAN, when you have a cert for it
sleep 20   # let Monitor prove it is not restart-looping
"${SSH[@]}" 'echo "--- Monitor restarts of web-server in the last minute: $(grep -c "web-server" /mnt/UDISK/creality/userdata/log/Monitor.log 2>/dev/null | tail -1) total; recent:"; tail -3 /mnt/UDISK/creality/userdata/log/Monitor.log | cut -c1-120'
if [ -n "$NAME" ]; then
  if curl -s -m 8 --resolve "$NAME:443:$IP" "https://$NAME/api/version" >/dev/null; then echo "k2ctl is on https://$NAME"; else echo "k2ctl did not answer on 443" >&2; exit 1; fi
elif curl -sk -m 8 "https://$IP/api/version" >/dev/null; then echo "k2ctl answers on https://$IP (no K2_CERT_NAME set, certificate not checked)"
else echo "k2ctl did not answer on 443" >&2; exit 1; fi
curl -sk -m 6 -o /dev/null -w "creality https on 8443 -> HTTP %{http_code}\n" "https://$IP:8443/" || true
