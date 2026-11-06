#!/bin/zsh
# Runs the checks a pull request's CI runs, in the same order, and stops at the first that fails:
# `npm run check` from the repository root, after `npm ci`. Two are left out:
# - Dependency review, which only GitHub can do on a pull request.
# - The Speech eval, which needs the models and a minute or two. crates/lab/README.md says how to run it.
set -euo pipefail
cd "${0:A:h}/.."

step() { print -P "\n%B== $1%b"; }

step "Known vulnerabilities in the npm packages"
npm audit --audit-level=moderate
step "Advisories, licences, bans and sources of the Rust crates"
if ! command -v cargo-deny >/dev/null; then
  print "cargo-deny is not installed: cargo install --locked cargo-deny" >&2; exit 1
fi
cargo deny check advisories bans licenses sources
step "Typecheck and build the frontend"
npm run build
step "Frontend unit tests"
npm test
step "Formatting"
cargo fmt --all --check
step "Clippy"
cargo clippy --workspace --all-targets --locked -- -D warnings
step "Rust tests"
cargo test --workspace --locked
step "Engine tests on their own"
cargo test -p dictate-engine --locked
step "Engine docs"
RUSTDOCFLAGS="-D warnings" cargo doc -p dictate-engine --no-deps --locked
step "Engine does not depend on Tauri"
# Into a variable first: a `grep -q` that stops reading early would end the pipe with SIGPIPE, which
# pipefail reads as no match.
tree=$(cargo tree -p dictate-engine -e normal --locked)
if grep -qi tauri <<<"$tree"; then
  print "dictate-engine depends on Tauri: the engine must stay free of the app's framework" >&2; exit 1
fi
print -P "\n%BAll checks passed.%b"
