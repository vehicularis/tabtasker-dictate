# dictate-engine

The speech pipeline behind TabTasker Dictate, with no app around it: samples in, text out.

A hold goes through these stages in order:

1. Audio gate (`audio`): drops silence and clips too short to be worth a pass.
2. Speech detection (`vad`): finds where voices are.
3. Language (`pipeline::language`): the held language, or Whisper's guess.
4. Whisper (`whisper`, `pipeline::hear`), with the echo guard (`prompt`) against a recited vocabulary.
5. Decode cleanup (`cleanup`): silent segments and repetition loops.
6. Text rules (`text`): replacements, fillers and the app's style.

Notes are cut into pieces (`pieces`); meetings are segments plus speakers (`meeting`).

Recording, typing, settings, history and the app are not here.

## Tests

```sh
cargo test -p dictate-engine
```

Tests that need a model are `#[ignore]`d. To run them, point `DICTATE_MODELS` at a folder holding the models (for example the Small model) and include the ignored tests:

```sh
DICTATE_MODELS=/path/to/models cargo test -p dictate-engine -- --ignored
```

## Rule

Nothing here may depend on Tauri or AppKit. The engine holds no `extern "C"` block and no `#[no_mangle]`, and its only `unsafe` is the whisper-rs callbacks in `whisper.rs`.
