# TabTasker Dictate

Talk instead of typing, on your Mac. Speech is transcribed on the Mac by Whisper and never leaves it.

- **Hold fn and talk.** Your words type into whatever field has the cursor, in any app, while you speak.
  Let go and the last words are settled.
- **Take long notes.** Click the note button on the dots at the bottom of the screen and talk for as long
  as you like. The note is transcribed while you talk, a sentence at a time, so it is ready the moment you
  stop. Review the title and words, then save it as a Markdown file in `~/Documents/TabTasker Dictate`.

It runs from the menu bar, with no account and nothing to sign in to.

## How it works

| Part | What it does |
| --- | --- |
| `src-tauri/src/dictate.m` | The fn key, the microphone (with a picker for other inputs), and typing your words as keystrokes. |
| `src-tauri/src/speech.rs` | Whisper large-v3 Turbo on Metal, through [whisper.cpp](https://github.com/ggml-org/whisper.cpp). It uses the [audio-context fine-tune](https://huggingface.co/MahmoudAshraf/acft-whisper-large-v3-turbo) so the encoder reads only the speech, not a padded 30-second window. Silero VAD finds where speech ends. |
| `src-tauri/src/speech_note.rs` | Long notes: the audio is cut where you pause and each piece is transcribed once, while you are still talking. |
| `src/Overlay.tsx` | The dots, the orb, the note's review card and setup, in a transparent window. |

The first launch downloads the model once (about 875 MB) from
[vehicularis-edge-models](https://github.com/vehicularis/vehicularis-edge-models/releases), checking its size
and SHA-256.

## Build

You need macOS 13 or later on Apple silicon, Rust, Node 22 or later, and Xcode's command line tools.

```sh
npm install
npm run tauri dev      # run from source
npm run tauri build    # TabTasker Dictate.app and a DMG in src-tauri/target/release/bundle
```

macOS asks for the microphone, and for Accessibility, which lets the app hear fn in other apps and type
your words into them. If **System Settings › Keyboard › Press 🌐 key to** is set to anything other than
**Do Nothing**, holding fn also does that, and setup tells you.

## License

Apache-2.0, see [LICENSE](LICENSE). The models and libraries it uses are listed with their licenses in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
