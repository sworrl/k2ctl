#!/bin/bash
# k2ctl installer. Builds everything, puts the backend on the printer, puts the tray app on
# this desktop and makes both start on their own at boot.
#
#   ./install.sh                     ask for what it needs, do the whole thing
#   ./install.sh --printer 192.168.1.50 --password abc123
#   ./install.sh --desktop-only      just the tray app on this machine
#   ./install.sh --printer-only      just the backend on the printer
#   ./install.sh --uninstall [--printer IP]
#
# Works on Debian/Ubuntu style systems (anything with apt). Other distros: install the
# packages listed in need_packages() yourself, then rerun with --no-apt.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PRINTER="${K2_IP:-}"
PASSWORD="${K2_ROOT_PW:-}"
DO_DESKTOP=1
DO_PRINTER=1
AUTOSTART=1
USE_APT=1
ASSUME_YES=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --printer)      PRINTER="$2"; shift ;;
    --password)     PASSWORD="$2"; shift ;;
    --desktop-only) DO_PRINTER=0 ;;
    --printer-only) DO_DESKTOP=0 ;;
    --no-autostart) AUTOSTART=0 ;;
    --no-apt)       USE_APT=0 ;;
    --uninstall)    UNINSTALL=1 ;;
    -y|--yes)       ASSUME_YES=1 ;;
    -h|--help)      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\n==> %s\n' "$*"; }
die()  { printf 'k2ctl: %s\n' "$*" >&2; exit 1; }
# Prompts read from the terminal so "curl ... | bash" still works.
ask()  { local v; if [ -r /dev/tty ]; then read -r -p "$1" v </dev/tty; else read -r -p "$1" v; fi; printf '%s' "$v"; }
asks() { local v; if [ -r /dev/tty ]; then read -r -s -p "$1" v </dev/tty; else read -r -s -p "$1" v; fi; echo >&2; printf '%s' "$v"; }

need_packages() {
  echo git curl ca-certificates build-essential cmake sshpass golang-go nodejs npm qt6-base-dev qt6-webengine-dev
}

# ---------- uninstall ----------
if [ "$UNINSTALL" = 1 ]; then
  say "removing the tray app from this desktop"
  pkill -x k2ctl-tray 2>/dev/null || true
  rm -f "$HOME/.local/bin/k2ctl-tray" "$HOME/.local/share/applications/k2ctl-tray.desktop" \
        "$HOME/.config/autostart/k2ctl-tray.desktop"
  for s in 32 48 64 128 256 512; do rm -f "$HOME/.local/share/icons/hicolor/${s}x${s}/apps/k2ctl.png"; done
  echo "tray removed. Your settings file ~/.config/k2ctl/tray.conf is still there; delete it if you want."
  if [ -n "$PRINTER" ]; then
    say "removing k2ctl from the printer at $PRINTER"
    SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8)
    [ -n "$PASSWORD" ] && SSH=(sshpass -p "$PASSWORD" "${SSH[@]}")
    "${SSH[@]}" "root@$PRINTER" '/etc/init.d/k2ctl stop 2>/dev/null; /etc/init.d/k2ctl disable 2>/dev/null; rm -f /etc/init.d/k2ctl; rm -rf /mnt/UDISK/k2ctl; echo "k2ctl files removed from the printer"'
    echo "If you used install-443.sh or printer-ui-logo.sh, run those with --revert as well."
  else
    echo "The printer side was left alone. Add --printer <ip> to remove it there too."
  fi
  exit 0
fi

# ---------- dependencies ----------
if [ "$USE_APT" = 1 ]; then
  command -v apt-get >/dev/null || die "this installer uses apt. On another distro install: $(need_packages), then rerun with --no-apt."
  missing=()
  for p in $(need_packages); do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  # Only the tray needs Qt; only the printer part needs the cross compile (Go does that itself).
  if [ "$DO_DESKTOP" = 0 ]; then missing=("${missing[@]/qt6-base-dev}"); missing=("${missing[@]/qt6-webengine-dev}"); fi
  missing=("${missing[@]}")
  if [ ${#missing[@]} -gt 0 ] && [ -n "${missing[*]// }" ]; then
    say "installing packages: ${missing[*]} (sudo will ask for your password)"
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends ${missing[*]}
  fi
fi

# Go 1.22+ is needed. Ubuntu 24.04 and newer ship it; older ones get a private copy.
GO=go
if ! command -v go >/dev/null || [ "$(go version | sed -E 's/.*go1\.([0-9]+).*/\1/')" -lt 22 ] 2>/dev/null; then
  GOV=1.22.12
  case "$(uname -m)" in x86_64) GOARCH=amd64 ;; aarch64) GOARCH=arm64 ;; *) die "no Go download for $(uname -m); install Go 1.22+ yourself" ;; esac
  say "your Go is missing or older than 1.22, fetching Go $GOV into ~/.local/go"
  mkdir -p "$HOME/.local"
  curl -fsSL "https://go.dev/dl/go${GOV}.linux-${GOARCH}.tar.gz" | tar -xz -C "$HOME/.local"
  GO="$HOME/.local/go/bin/go"
fi
export PATH="$(dirname "$GO"):$PATH"

nodev="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
[ "$nodev" -ge 18 ] || die "Node.js 18 or newer is needed (found ${nodev:-none}). On Ubuntu 22.04: https://github.com/nodesource/distributions"

# ---------- printer details ----------
if [ "$DO_PRINTER" = 1 ]; then
  if [ -z "$PRINTER" ]; then
    echo
    echo "The printer's IP address is under Settings > Network on the touchscreen."
    PRINTER="$(ask 'Printer IP address: ')"
  fi
  [ -n "$PRINTER" ] || die "no printer address given"
  if ! curl -s -m 4 "http://$PRINTER:7125/server/info" >/dev/null; then
    echo "Nothing answered on $PRINTER:7125 (Moonraker). Is the printer on and on this network?"
    [ "$ASSUME_YES" = 1 ] || { r="$(ask 'Continue anyway? [y/N] ')"; case "$r" in y|Y) ;; *) exit 1 ;; esac; }
  fi
  if [ -z "$PASSWORD" ]; then
    echo
    echo "Turn on the root account under Settings > Root account on the touchscreen; it shows a password."
    PASSWORD="$(asks 'Printer root password (not shown as you type): ')"
  fi
  [ -n "$PASSWORD" ] || die "no root password given"
fi

# ---------- build ----------
if [ "$DO_PRINTER" = 1 ]; then
  say "building the dashboard and the printer binary (first time takes a few minutes)"
  make web arm backend
fi
if [ "$DO_DESKTOP" = 1 ]; then
  say "building the tray app"
  make tray
fi

# ---------- printer ----------
if [ "$DO_PRINTER" = 1 ]; then
  say "installing on the printer at $PRINTER"
  K2_ROOT_PW="$PASSWORD" deploy/deploy.sh "$PRINTER"
  # deploy.sh enables /etc/init.d/k2ctl, so it comes back after every printer reboot.
fi

# ---------- desktop ----------
if [ "$DO_DESKTOP" = 1 ]; then
  say "installing the tray app for this user"
  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
  install -m 755 tray/build/k2ctl-tray "$HOME/.local/bin/k2ctl-tray"
  sed "s|^Exec=.*|Exec=$HOME/.local/bin/k2ctl-tray|" tray/k2ctl-tray.desktop > "$HOME/.local/share/applications/k2ctl-tray.desktop"
  for s in 32 48 64 128 256 512; do
    d="$HOME/.local/share/icons/hicolor/${s}x${s}/apps"; mkdir -p "$d"
    cp "assets/k2ctl-icon-${s}.png" "$d/k2ctl.png"
  done
  conf="$HOME/.config/k2ctl/tray.conf"
  if [ -n "$PRINTER" ] || [ ! -f "$conf" ]; then
    mkdir -p "$(dirname "$conf")"
    if [ -n "$PRINTER" ]; then
      printf '[General]\nbackend=http://%s:8085\n' "$PRINTER" > "$conf"
    else
      echo "No printer address given and no ~/.config/k2ctl/tray.conf yet; the tray will ask on first start."
    fi
  fi
  if [ "$AUTOSTART" = 1 ]; then
    mkdir -p "$HOME/.config/autostart"
    sed "s|^Exec=.*|Exec=$HOME/.local/bin/k2ctl-tray|" tray/k2ctl-tray.desktop > "$HOME/.config/autostart/k2ctl-tray.desktop"
  fi
  command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  pkill -x k2ctl-tray 2>/dev/null || true
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    (setsid -f "$HOME/.local/bin/k2ctl-tray" >/dev/null 2>&1 </dev/null) || true
  fi
fi

# ---------- done ----------
echo
echo "Done."
[ "$DO_PRINTER" = 1 ] && echo "  Dashboard:  http://$PRINTER:8085   (starts with the printer from now on)"
[ "$DO_DESKTOP" = 1 ] && echo "  Tray app:   look for the K2 icon in your system tray${AUTOSTART:+ (starts with your desktop)}"
echo "  Update:     cd $HERE && git pull && ./install.sh${PRINTER:+ --printer $PRINTER}"
echo "  Remove:     $HERE/install.sh --uninstall${PRINTER:+ --printer $PRINTER}"
