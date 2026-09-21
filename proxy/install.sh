#!/usr/bin/env bash
# Hermes G2 proxy installer for Linux / macOS. Run on the machine that runs Hermes Agent:
#   curl -fsSL https://raw.githubusercontent.com/lonelycode/hermes-g2/main/proxy/install.sh | bash
set -euo pipefail

PKG="${HERMES_G2_PACKAGE:-github:lonelycode/hermes-g2}"

need_node() {
  cat <<'MSG'
Node.js 22 or newer is required (20 works without live transcription).
Install it, then re-run this script:
  macOS:          brew install node
  Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
  Fedora/RHEL:    sudo dnf install nodejs
  any Linux/mac:  curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22
MSG
  exit 1
}

command -v node >/dev/null 2>&1 || need_node
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  echo "Found Node $(node -v); too old."
  need_node
fi
[ "$major" -lt 22 ] && echo "Note: Node $(node -v) runs the proxy, but live transcription needs Node 22+."

echo "Installing the Hermes G2 proxy from $PKG …"
# npx from the git repo (or the npm package once published) and launch the wizard.
exec npx --yes --package="$PKG" hermes-g2-proxy setup
