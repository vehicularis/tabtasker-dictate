# Working in this repository

For people and for AI coding agents. Claude Code reads this file through [CLAUDE.md](CLAUDE.md).

- How the pieces fit together: [docs/architecture.md](docs/architecture.md).
- How to contribute (pull requests, releases): [CONTRIBUTING.md](CONTRIBUTING.md).

TabTasker Dictate is a Mac menu bar app: hold fn, talk, and your words are typed where the cursor is. It also
keeps voice notes, stickies and meeting transcripts. The speech runs on the Mac: Whisper on Metal, speech
detection and speaker separation. It is a Tauri 2 app for Apple silicon on macOS 13 or later.

## Where things are

| Path | What lives there |
|---|---|
| `crates/engine/` | `dictate-engine`, the speech pipeline: audio gates, speech detection, language, Whisper, text rules, voice-note pieces, meeting transcripts, the model catalog. No Tauri, no AppKit. |
| `crates/lab/` | `dictate-lab`, which runs the engine on WAV files stage by stage and scores spoken fixtures. [Its README](crates/lab/README.md). |
| `src-tauri/src/` | The app: commands, windows, menus, settings, history, notes, stickies, meetings, Claude, and the MCP server. |
| `src-tauri/src/native/` | Objective-C: the dictate key, the microphone, typing into other apps, the overlay's native parts, meeting audio, the Keychain. |
| `src/api/` | The typed contract with the Rust side: every command, every event, every shared type. |
| `src/bridge.ts` | The only code that calls Tauri. In a plain browser it loads `src/mock/` instead. |
| `src/lib/` | The frontend's rules, as plain functions, each beside its `*.test.ts`. |
| `src/ui/` | The shared design system and its hooks. |
| `src/app/`, `src/overlay/`, `src/sticky/` | The three windows: the app window, the dots and pill over every screen, and one sticky. |
| `src/editor/`, `src/onboarding/` | The note editor, and the setup flow. |
| `src/mock/` | The Mac side in memory, so the windows run in a browser. |

## Commands

You need a Mac with Apple silicon and Xcode's command line tools (the native code and Whisper's Metal build
need them), Rust stable, and Node 24 (`.nvmrc`). Run `npm ci` once.

```sh
npm run check                  # CI's checks, in its order (scripts/check.sh)
npm test                       # the frontend's rules, in a second
cargo test -p dictate-engine   # the speech pipeline's rules, no models needed
npm run dev                    # the windows in a browser, on the mock (see below)
```

`npm run dev` serves these pages:

- `http://localhost:1420/app.html`: the app window;
- `index.html`: the overlay (add `?preview=` for its states, see `src/overlay/preview.ts`);
- `sticky.html?id=demo`: a sticky;
- `lab.html`: every setup step at once.

After changing anything under `crates/engine`, `src-tauri/src/dictation` or `src-tauri/src/meetings`, or the
Cargo files, score the spoken fixtures. CI's Speech eval does the same on those paths.

```sh
cargo build -p dictate-lab --release
target/release/dictate-lab fetch --model small   # the models, once, into target/models
target/release/dictate-lab fixtures              # render the fixtures with macOS say
target/release/dictate-lab eval --model small    # score them
```

A few Rust tests are `#[ignore]`d because they need downloaded models. They say which environment
variable points at them (`DICTATE_MODELS`, for example). Point it at a scratch folder, never at the app's
own data.

## Don't

- **Don't run the app to check a change unless you mean to.** `npm run tauri dev` and
  `scripts/install-local.sh` use the person's real things:
  - the notes folder (`~/Documents/TabTasker Dictate` unless changed);
  - the app's data in `~/Library/Application Support/com.tabtasker.dictate`;
  - the Keychain items, the microphone and the Accessibility permission;
  - while fn dictates, the Mac's own setting for what the globe key does.

  Check the windows on the mock in a browser, and check speech with `dictate-lab`. Neither touches any of
  those.
- **Don't commit audio.** Apple's licence limits what its voices' output may be used for, so fixtures
  commit only their text, and `say` renders them into `target/`.
- **Don't import `node:*` in a frontend test.** The repo has no Node types. To read a file, use Vite's
  `?raw` or `import.meta.glob`, as `src/api/contract.test.ts` does.
- **Don't add a dependency when the platform can do the job.** A new one must be MIT, Apache-2.0, BSD, ISC
  or Zlib licensed, pinned to an exact version, and at least 14 days old. Then run
  `node scripts/notices.mjs`.

## How the layers stay apart

Rules 1 to 3 have checks that fail when they break. Rules 4 to 6 are kept by review, so check them yourself.

1. **The engine knows nothing of the app.**
   - `crates/engine` depends on no Tauri crate. CI's `cargo tree` step fails otherwise.
   - Every public item has a `///` doc (`#![deny(missing_docs)]`).
   - Unsafe code lives only in `whisper.rs`.
2. **A command lives in four places**, or the tests fail:
   - a `#[tauri::command]` in `src-tauri/src/`;
   - its name in `generate_handler!` (`src-tauri/src/lib.rs`);
   - its args and result in `src/api/commands.ts`;
   - a handler in `src/mock/`.

   The checks:
   - `src/api/contract.test.ts` compares `COMMANDS` with the names in `generate_handler!`. It also holds a
     count of the commands (74 today), so update that number when you add one.
   - `src/mock/mock.test.ts` checks that every command has a handler.
   - `tsc` checks every call's arguments and result against `Commands`, and
     `src/api/commands.typecheck.ts` pins the calls that must not compile.

   Across the bridge:
   - argument names are camelCase on the JS side;
   - `Option<T>` is `?: T | null`;
   - `Result<T, String>` rejects with the string, which is the sentence the page shows.
3. **An event is emitted from Rust as `dictate-<name>`,** and has its payload in `src/api/events.ts`.
   The contract test compares `EVENTS` with every `dictate-*` name passed to an `emit` or `emit_to` in
   `src-tauri/src`, and holds their count (20 today) too.
4. **A rule the windows follow is a plain function in `src/lib/<area>.ts`,** with a test beside it.
   - Modules there import nothing from React, `src/ui/`, a `.tsx` file or TipTap, and touch the DOM only
     inside a function, never at import.
   - Time comes in as an argument (`now`).
   - Tests run in node, in New York time and US English, so dates and number formats are fixed.
   - `lib/clipboard.ts` and `lib/request.ts` are the two platform calls allowed there.
   - Some older rules still sit beside their React code: helpers in `store.ts`, `useTabDrag` in
     `app/tabs.ts`, and the TipTap appliers in `editor/textTransforms.ts`.
5. **AppKit and the voice state are touched only on the main thread.** From Rust that means
   `run_on_main_thread`, or `on_main` in `app/commands.rs`.
6. **Everything the app calls between Rust and Objective-C is named `dictate_*`.** Native code tells the
   windows things through the `dictate_ui_*` functions in `app/events.rs`. The one exception is the plain C
   `tt_*` key logic in `keys.m`, which `src-tauri/tests/keys.rs` calls directly.

A new `.m` file in `src-tauri/src/native/` is compiled without editing `build.rs`, but run
`touch src-tauri/build.rs` once so Cargo notices it.

## Conventions

- **Formatting.** Rust and TypeScript use 2-space indents (`.editorconfig`), and long lines are fine. No
  formatter is enforced, so match the code around you.
- **Comments** say only what the code can't: the why, an invariant, a gotcha.
  - `///` docs are plain sentences.
  - `ponytail:` marks a deliberate simplification, with its ceiling and the way up.
- **Errors** a person sees are short plain English. Logs never hold recognised words or keys.
- **Mutexes** are taken with `.lock().unwrap_or_else(|e| e.into_inner())`, or the `lock()` helper in
  `dictation/speech.rs`, so one panicked pass never wedges the app.
- **UI copy** is sentence case, short and plain, with no em or en dashes. Use curly apostrophes in copy
  (`Couldn’t`), and straight ones in code.
- **Tests** pin what the code does today. A bug a test finds gets fixed in the same change, with that test.
- **Pull requests:**
  - one change each, squash-merged;
  - a title that says what changes for the person using Dictate;
  - a line under Unreleased in [CHANGELOG.md](CHANGELOG.md) for anything they would notice.
