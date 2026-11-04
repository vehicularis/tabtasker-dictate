#!/bin/zsh
# Builds a TabTasker Dictate release for Apple silicon that opens without a warning when downloaded:
# the app signed with the Developer ID (hardened runtime, secure timestamp), notarized and stapled; then a
# DMG of it beside an Applications link, signed, notarized and stapled too; then both checked the way
# Gatekeeper checks a download. The DMG lands in release/, named for the version in tauri.conf.json.
#
#   scripts/release-mac.sh [notarytool keychain profile]     (default: tabtasker-dictate)
#
# Once per Mac: the Developer ID Application certificate in your login keychain, and the profile, from an
# App Store Connect API key (Users and Access › Integrations › Team Keys, the Developer role is enough):
#
#   xcrun notarytool store-credentials tabtasker-dictate --key AuthKey_KEYID.p8 --key-id KEYID --issuer ISSUER
#
# Then publish it: gh release create vX.Y.Z release/TabTasker-Dictate-X.Y.Z-arm64.dmg --target <commit>
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$HOME/.nvm/versions/node/v22.16.0/bin:$HOME/.cargo/bin:$PATH"
PROFILE="${1:-tabtasker-dictate}"
IDENTITY="${DICTATE_SIGNING_IDENTITY:-Developer ID Application: VEHICULARIS LIMITED (FZJT9G5S86)}"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
APP="src-tauri/target/release/bundle/macos/TabTasker Dictate.app"
DMG="release/TabTasker-Dictate-$VERSION-arm64.dmg"
mkdir -p release

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
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$APP"
rm -f "$ZIP"

echo "== the DMG, notarized"
STAGE=$(mktemp -d)
ditto "$APP" "$STAGE/TabTasker Dictate.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "TabTasker Dictate" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
rm -rf "$STAGE"
codesign --sign "$IDENTITY" --timestamp "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"

echo "== checked as a download"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
MOUNT=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG" >/dev/null
xcrun stapler validate "$MOUNT/TabTasker Dictate.app"
spctl --assess --type execute --verbose=2 "$MOUNT/TabTasker Dictate.app"
hdiutil detach "$MOUNT" >/dev/null
shasum -a 256 "$DMG"
echo "Ready: $DMG, from $(git rev-parse --short HEAD)."
