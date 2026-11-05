# Contributing

Thanks for helping make Dictate better. Bug reports, ideas and pull requests are all welcome.

- **A bug or an idea:** open an [issue](https://github.com/vehicularis/tabtasker-dictate/issues/new/choose).
- **A change bigger than a small fix:** open an issue first, so we can agree on the approach before you
  spend time on it.
- **A security problem:** follow [SECURITY.md](SECURITY.md), never a public issue.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Building

You need a Mac with Apple silicon on macOS 13 or later, Rust (stable), Node 24 and Xcode's command line
tools.

```sh
npm install
npm run tauri dev
```

The windows also run in a browser, on a mock of the Mac side, which is the quickest way to work on the UI.
Run `npm run dev` and open `http://localhost:1420/app.html` for the main window, or
`http://localhost:1420/lab.html` for every setup step at once.

## Checks

A pull request runs these in CI, the security checks before anything builds. Run them first:

```sh
npm audit --audit-level=moderate                    # known vulnerabilities in the npm packages
npm run build                                       # TypeScript and Vite
cd src-tauri
cargo deny check                                    # the crates' advisories, licences and sources
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

`cargo deny` comes from `cargo install --locked cargo-deny`. CI also reviews the dependencies a pull request
adds, and runs the security checks every Monday so a new advisory shows up without a push.

## Pull requests

- One change per pull request, with a title that says what it changes for the person using Dictate.
- Pull requests are squash-merged, so `main` stays one straight line.
- Anything a person using Dictate would notice gets a line under Unreleased in [CHANGELOG.md](CHANGELOG.md).
- For UI changes, check light and dark, and that every control works from the keyboard.
- UI copy is sentence case, short and plain. No em or en dashes.
- Code comments say only what the code can't: the why, an invariant, a gotcha.
- Dependencies: avoid one when the platform can do the job. A new one must be MIT, Apache-2.0, BSD, ISC or
  Zlib licensed, pinned to an exact version, and at least 14 days old. After changing dependencies, run
  `node scripts/notices.mjs` to update [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). The licences
  CI accepts across the crates are in [src-tauri/deny.toml](src-tauri/deny.toml).

## Releases

A release is a commit on `main` that sets the version in `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and their lock files, and gives it a section in [CHANGELOG.md](CHANGELOG.md). Pushing
its tag runs the [release workflow](.github/workflows/release.yml):

```sh
git tag v0.1.2 && git push origin v0.1.2
```

It runs the security checks, then [scripts/release-mac.sh](scripts/release-mac.sh): the app and its DMG signed
with the Developer ID, notarized, stapled and checked by Gatekeeper, the update (the app as a `.app.tar.gz`
signed with the updater key, from the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
secrets) with the `latest.json` that points to it, and a SHA256SUMS file. It attests where the DMG came from and
leaves the files on a draft release. Write the notes, download the DMG and check it the way the README asks
people to, then publish it as the latest release: installed copies update from the release marked Latest.

```sh
gh attestation verify TabTasker-Dictate-0.1.2-arm64.dmg -R vehicularis/tabtasker-dictate
```

Run the workflow by hand from the Actions tab for a dry run: the same build signed ad hoc, with no secrets and no
release. A pull request that changes how a release is built runs one too. The script also builds a release on
a Mac; it says at its top what it needs.

## Licence

Dictate is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contribution is
licensed under it too, as section 5 of the licence says.
