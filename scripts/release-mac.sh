#!/bin/zsh
# Builds a TabTasker Dictate release for Apple silicon that opens without a warning when downloaded:
# the app signed with the Developer ID (hardened runtime, secure timestamp), notarized and stapled; then a
# DMG of it that opens on its own window, the app and an Applications link on design/dmg-background.tiff
# (laid out by dmgbuild from scripts/dmg-settings.py, no Finder scripting), signed, notarized and stapled
# too; then both checked the way Gatekeeper checks a download. The DMG lands in release/, named for the version in
# tauri.conf.json, beside a SHA256SUMS file for it.
#
#   scripts/release-mac.sh [notarytool keychain profile]     (default: tabtasker-dictate)
#
# A pushed vX.Y.Z tag runs this in .github/workflows/release.yml, which publishes nothing itself: it leaves a
# draft release for a person to publish. There the notary credentials are an App Store Connect API key, its
# .p8 file in NOTARY_KEY with NOTARY_KEY_ID and NOTARY_ISSUER, instead of a profile. DICTATE_SIGNING_IDENTITY=-
# is a dry run: the same build signed ad hoc, which can be neither notarized nor accepted by Gatekeeper.
#
# Once per Mac: the Developer ID Application certificate in your login keychain, and the profile, from an
# App Store Connect API key (Users and Access › Integrations › Team Keys, the Developer role is enough):
#
#   xcrun notarytool store-credentials tabtasker-dictate --key AuthKey_KEYID.p8 --key-id KEYID --issuer ISSUER
#
# Then publish it: gh release create vX.Y.Z release/TabTasker-Dictate-X.Y.Z-arm64.dmg release/SHA256SUMS --target <commit>
set -euo pipefail
cd "$(dirname "$0")/.."
# Node 24 or later: nvm's newest v24 when there is one, else whatever is on the PATH. Homebrew and cargo go after
# the PATH, not before it: a GitHub runner's Homebrew has an older Node than the one CI sets up.
NODE24=( $HOME/.nvm/versions/node/v24.*/bin(N/n) )
export PATH="${NODE24:+$NODE24[-1]:}$PATH:/opt/homebrew/bin:$HOME/.cargo/bin"
node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' 2>/dev/null || { echo "Dictate builds with Node 24 or later: nvm install 24"; exit 1; }
PROFILE="${1:-tabtasker-dictate}"
IDENTITY="${DICTATE_SIGNING_IDENTITY:-Developer ID Application: VEHICULARIS LIMITED (FZJT9G5S86)}"
if [[ -n "${NOTARY_KEY:-}" ]]; then NOTARY=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
else NOTARY=(--keychain-profile "$PROFILE"); fi
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
APP="src-tauri/target/release/bundle/macos/TabTasker Dictate.app"
DMG="release/TabTasker-Dictate-$VERSION-arm64.dmg"
mkdir -p release

# Sends $1 to Apple's notary service and staples the ticket to $2.
notarize() {
  [[ "$IDENTITY" == - ]] && { echo "Signed ad hoc, so not notarized."; return; }
  xcrun notarytool submit "$1" "${NOTARY[@]}" --wait
  xcrun stapler staple "$2"
}
# Asks Gatekeeper about a file the way it asks about a download. Its answer has to say notarized: on a Mac with
# assessments turned off, spctl accepts everything.
gatekeeper() {
  local answer
  answer=$(spctl --assess --verbose=2 "$@" 2>&1) || true
  echo "$answer"
  [[ "$answer" == *"source=Notarized Developer ID"* ]] || { echo "Gatekeeper doesn't accept it as notarized."; exit 1; }
}

echo "== $VERSION, built and signed"
[[ -z "$(git status --porcelain)" ]] || { echo "The tree has changes: commit them, so the release is a commit."; exit 1; }
APPLE_SIGNING_IDENTITY="$IDENTITY" npm run tauri build -- --bundles app
codesign --verify --deep --strict "$APP"
SIG=$(codesign -dv --verbose=4 "$APP" 2>&1) # read whole: grep -q under pipefail would cut codesign off (SIGPIPE)
[[ "$SIG" == *"flags=0x10000(runtime)"* ]] || { echo "No hardened runtime: notarization would refuse it."; exit 1; }
[[ "$(lipo -archs "$APP/Contents/MacOS/tabtasker-dictate")" == arm64 ]] || { echo "Not an Apple silicon build."; exit 1; }

echo "== the app, notarized"
ZIP="release/app-for-notary.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
notarize "$ZIP" "$APP"
rm -f "$ZIP"

echo "== the DMG, laid out and notarized"
[[ -x release/.venv/bin/dmgbuild ]] || { /usr/bin/python3 -m venv release/.venv && release/.venv/bin/pip install -q dmgbuild==1.6.5; }
rm -f "$DMG"
release/.venv/bin/dmgbuild -s scripts/dmg-settings.py -D app="$APP" "TabTasker Dictate" "$DMG" >/dev/null
codesign --sign "$IDENTITY" --timestamp "$DMG"
notarize "$DMG" "$DMG"

echo "== checked as a download"
MOUNT=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG" >/dev/null
if [[ "$IDENTITY" == - ]]; then
  codesign --verify --deep --strict "$MOUNT/TabTasker Dictate.app"
else
  xcrun stapler validate "$DMG"
  gatekeeper --type open --context context:primary-signature "$DMG"
  xcrun stapler validate "$MOUNT/TabTasker Dictate.app"
  gatekeeper --type execute "$MOUNT/TabTasker Dictate.app"
fi
hdiutil detach "$MOUNT" >/dev/null
(cd release && shasum -a 256 "${DMG:t}" | tee SHA256SUMS)
echo "Ready: $DMG, from $(git rev-parse --short HEAD)."
