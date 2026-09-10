#!/bin/bash
# One line install:   curl -fsSL https://raw.githubusercontent.com/sworrl/k2ctl/master/get.sh | bash
# Clones (or updates) the repo into ~/k2ctl and runs install.sh, which asks for the rest.
# Options after "bash -s --" go to install.sh, e.g.  ... | bash -s -- --printer 192.168.1.50
set -euo pipefail
REPO="${K2CTL_REPO:-https://github.com/sworrl/k2ctl.git}"
DIR="${K2CTL_DIR:-$HOME/k2ctl}"
if ! command -v git >/dev/null 2>&1; then
  echo "==> installing git (sudo will ask for your password)"
  sudo apt-get update -qq && sudo apt-get install -y git
fi
if [ -d "$DIR/.git" ]; then
  echo "==> updating $DIR"; git -C "$DIR" pull --ff-only
else
  echo "==> downloading k2ctl into $DIR"; git clone "$REPO" "$DIR"
fi
exec "$DIR/install.sh" "$@"
