# k2ctl on port 443 (resolved 2026-09-10)

Creality's `web-server` has 80, 443 and 9999 compiled in (no config file, no iptables on
the box). Two ways were tried:

1. **Wrapper script at `/usr/bin/web-server`** that preloaded the shim and exec'd the real
   binary from `/mnt/UDISK/k2ctl/orig/`. Do not repeat this. Creality's `Monitor` watchdog
   checks the process by its exact path, relaunched web-server every ~10 s, 16 copies piled
   up, the printer ran out of memory and rebooted, and something restored the stock binary.
2. **`/etc/ld.so.preload` loading `/lib/k2ctl-bindshim.so`** (current). The stock binary stays at
   `/usr/bin/web-server` untouched, so Monitor and procd are happy. The shim links only
   `GLIBC_2.4` symbols, overrides `bind()` via the raw syscall, and acts **only in a process
   whose name is `web-server`** (everything else on the box gets a plain `bind()`; k2ctl is
   static Go and never loads it). Verified: single web-server pid, zero Monitor restarts after
   the deliberate `killall`, Creality HTTPS answers on 8443, k2ctl on 443.

`deploy/install-443.sh` applies it (idempotent, checks the shim is mapped, waits and counts
Monitor restarts) and `--revert` undoes it. `deploy/k2ctl.init` carries `-tls-listen :443`.
Redo after a firmware update. If the overlay is wiped and `/etc/ld.so.preload` disappears,
web-server takes 443 again and k2ctl's TLS listener fails to bind (HTTP on 8085 keeps
working); rerun the installer.
