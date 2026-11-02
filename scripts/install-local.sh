#!/bin/zsh
# Builds TabTasker Dictate, signs it for this Mac and puts it in /Applications, then opens it.
#
# macOS ties Accessibility and the microphone to the app's designated requirement. An ad-hoc signature's
# default requirement is the hash of that very build, so every rebuild would lose the permissions.
#
# Best: a local code-signing certificate named "TabTasker Dictate Dev" in your login keychain (Keychain
# Access › Certificate Assistant › Create a Certificate…, type Code Signing). The app is then signed with
# it and the requirement pins that certificate, so only builds you sign can inherit the permissions.
# Without one, the app is signed ad hoc with the bundle identifier alone as its requirement: the
# permissions survive rebuilds, but any other ad-hoc app on this Mac claiming the same identifier would
# inherit them too. Fine for a development Mac you trust; make the certificate for anything more.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$HOME/.nvm/versions/node/v22.16.0/bin:$HOME/.cargo/bin:$PATH"
NPM="$HOME/.nvm/versions/node/v22.16.0/bin/npm"
APP="src-tauri/target/release/bundle/macos/TabTasker Dictate.app"
"$NPM" run tauri build -- --bundles app
IDENTITY="TabTasker Dictate Dev"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
  LEAF=$(security find-certificate -c "$IDENTITY" -Z 2>/dev/null | awk '/SHA-1 hash/ { print $3; exit }')
  codesign --force --deep --sign "$IDENTITY" --identifier com.tabtasker.dictate -r "=designated => identifier \"com.tabtasker.dictate\" and certificate leaf = H\"$LEAF\"" "$APP"
  echo "Signed with the $IDENTITY certificate."
else
  codesign --force --deep --sign - --identifier com.tabtasker.dictate -r '=designated => identifier "com.tabtasker.dictate"' "$APP"
  echo "Signed ad hoc (no \"$IDENTITY\" certificate in the keychain); the permissions are tied to the bundle identifier alone."
fi
codesign --verify --deep --strict "$APP"
pkill -x tabtasker-dictate || true
sleep 1
rm -rf "/Applications/TabTasker Dictate.app"
ditto "$APP" "/Applications/TabTasker Dictate.app"
open -a "/Applications/TabTasker Dictate.app"
echo "Installed and opened. The log is at ~/Library/Logs/TabTasker Dictate/dictate.log"
