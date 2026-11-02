#!/bin/zsh
# Builds TabTasker Dictate, signs it for this Mac and puts it in /Applications, then opens it.
#
# There is no Apple signing identity here, so the app is signed ad hoc. macOS ties Accessibility and the
# microphone to the app's designated requirement; an ad-hoc signature's default requirement is the hash
# of that very build, so every rebuild would lose the permissions. Signing with an explicit requirement,
# the bundle identifier alone, keeps them across rebuilds: turn the permissions on once and they stay.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$HOME/.nvm/versions/node/v22.16.0/bin:$HOME/.cargo/bin:$PATH"
NPM="$HOME/.nvm/versions/node/v22.16.0/bin/npm"
APP="src-tauri/target/release/bundle/macos/TabTasker Dictate.app"
"$NPM" run tauri build -- --bundles app
codesign --force --deep --sign - --identifier com.tabtasker.dictate -r '=designated => identifier "com.tabtasker.dictate"' "$APP"
codesign --verify --deep --strict "$APP"
pkill -x tabtasker-dictate || true
sleep 1
rm -rf "/Applications/TabTasker Dictate.app"
ditto "$APP" "/Applications/TabTasker Dictate.app"
open -a "/Applications/TabTasker Dictate.app"
echo "Installed and opened. The log is at ~/Library/Logs/TabTasker Dictate/dictate.log"
