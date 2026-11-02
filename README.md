# TabTasker Dictate

Talk instead of typing, on your Mac. Speech is transcribed on the Mac by Whisper and never leaves it.

- **Hold fn and talk.** Your words type into whatever field has the cursor, in any app, while you speak.
  Let go and the last words are settled.
- **Take notes, spoken or typed.** Click the note on the dots and talk for as long as you like: when you
  stop, the note is saved as a Markdown file in `~/Documents/TabTasker Dictate` and opens in the window,
  named by the model if one is connected. Or press the plus in the window and type. Either way the note
  is yours to change in the Text editor from TabTasker Business: headings, lists, to-dos, quotes, code
  with colours, tables, pictures pasted in, links and highlights, from the bar, from “/”, or from the bar
  that comes up over a selection; dragged about by the handle; still a plain file underneath.
- **Keep stickies on the screen.** A small coloured note on top of everything: from the window, the dots’
  menu, a shortcut, or by voice, saying “sticky: call Thomas” while you dictate. It stays where you leave
  it; fold it to its bar or let other windows cover it when it is in the way; right-click it for its
  colours and everything else; it can become a note.
- **Record meetings with who said what.** Start one from the dots (the meeting button on their pill), the
  window or the menu bar. The room and, on a call, the other side are transcribed on this Mac as it goes.
  When you stop, every voice gets its own label: yours keeps your name, the others are Person 1, Person 2
  and on, each renamable in one go in the window. A summary, decisions and action items are written if a
  model is connected, each part a switch. No length limit beyond free disk space.
- **One window.** Notes, Meetings and Stickies in a sidebar, the one you pick open beside the list, and
  four settings pages: General, Notes & meetings, Claude & AI, Appearance. A model, once connected, works
  under the hood on titles, summaries, polish and spoken commands; there is nothing to chat with.

It runs from the menu bar, with no account and nothing to sign in to. A model is optional and works under
the hood, never opening anything: connect Claude in Settings through the Claude Code on your Mac with the
Claude account you signed in to there, with your own Anthropic key, or use a model running on this Mac
through Ollama, and it polishes what you dictate, answers spoken commands and summarises notes and
meetings. Only text ever goes to Claude, never audio.

## How it works

| Part | What it does |
| --- | --- |
| `src-tauri/src/dictate.m` | The fn key, the microphone (with a picker for other inputs), and typing your words as keystrokes. |
| `src-tauri/src/speech.rs` | Whisper large-v3 Turbo on Metal, through [whisper.cpp](https://github.com/ggml-org/whisper.cpp). It uses the [audio-context fine-tune](https://huggingface.co/MahmoudAshraf/acft-whisper-large-v3-turbo) so the encoder reads only the speech, not a padded 30-second window. Silero VAD finds where speech ends. |
| `src-tauri/src/speech_note.rs` | Long notes: the audio is cut where you pause and each piece is transcribed once, while you are still talking. |
| `src-tauri/src/settings.rs` | Settings in one JSON file in the app data folder, saved atomically and sent to every window. |
| `src/overlay/` | The dots, the orb, the note's review card and setup, in a transparent window. |
| `src/app/` | The app's window in TabTasker Business's Mac shell (tabs, an icon spine, a column, the page): your notes, meetings and stickies, the settings pages and Help, built from the shared design system in `src/ui/`. |

Without the app around it, `npm run dev` serves both pages to a browser with a mock of the app:
`http://localhost:1420/?preview=menu` for an overlay state, `http://localhost:1420/app.html#notes` for the
window, and `?theme=light` or `?theme=dark` on either.

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

Apache-2.0, see [LICENSE](LICENSE). The voice models and whisper.cpp it uses are listed with their licenses in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
