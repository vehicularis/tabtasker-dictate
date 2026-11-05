<p align="center">
  <img src="docs/images/icon.png" width="112" alt="">
</p>

<h1 align="center">TabTasker | Dictate</h1>

<p align="center">
  <strong>Talk, and it’s typed.</strong><br>
  Hold fn in any app, say what you want to write, and let go.
</p>

<p align="center">
  <a href="https://github.com/vehicularis/tabtasker-dictate/releases/latest"><strong>Download for Mac</strong></a><br>
  For Apple silicon, on macOS 13 or later
</p>

<p align="center">
  <a href="https://github.com/vehicularis/tabtasker-dictate/actions/workflows/ci.yml"><img src="https://github.com/vehicularis/tabtasker-dictate/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/vehicularis/tabtasker-dictate/releases/latest"><img src="https://img.shields.io/github/v/release/vehicularis/tabtasker-dictate?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/vehicularis/tabtasker-dictate" alt="Apache-2.0 licence"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/notes-dark.png">
    <img src="docs/images/notes-light.png" alt="A note open in TabTasker | Dictate, with the pill at the bottom of the screen showing what it hears">
  </picture>
</p>

Dictate lives in a thin pill at the edge of your screen. Wherever your cursor is, hold your key and talk.
Your words appear as you say them, and the finished text takes their place when you let go. The pill opens
up for everything else: a note you can talk into for as long as you like, a sticky that stays on top of your
windows, or a meeting recording.

## What’s in it

- Dictation in any app, in more than 40 languages. Say “send” at the end and it presses Return for you.
- Notes you can talk or type. They’re plain Markdown files in your Documents folder, so Obsidian and
  everything else can read them.
- Meeting recordings that tell the voices apart, including the other side of a call.
- Stickies that float over your windows until you close them. Say “sticky: call Thomas” while you dictate
  and one appears.
- AI if you want it. Connect Claude, OpenAI or any service that speaks the OpenAI API, or a model running
  on your Mac, and it’ll name your notes, summarise your meetings and tidy up what you dictate.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/meeting-dark.png">
    <img src="docs/images/meeting-light.png" alt="A meeting in TabTasker | Dictate with its summary, action items and a transcript by speaker">
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/stickies-dark.png">
    <img src="docs/images/stickies-light.png" alt="The Stickies page in TabTasker | Dictate, with six stickies in different colours">
  </picture>
</p>

## Privacy

Speech recognition runs on your Mac, so your voice never leaves it and you don’t need an account. If you
connect an AI model, it only ever gets text, and Settings shows you exactly what it sees.

## Get started

Download the DMG from the [latest release](https://github.com/vehicularis/tabtasker-dictate/releases/latest), open it and
drag TabTasker Dictate into Applications. You’ll need a Mac with Apple silicon on macOS 13 or later. It’s
signed and notarized, so it opens without a warning. The first time it opens, Dictate downloads its
speech model (about 875 MB) and walks you through the two permissions it needs.

To build it yourself, install Rust, Node 22 and Xcode’s command line tools, then:

```sh
npm install
npm run tauri dev      # run from source
npm run tauri build    # TabTasker Dictate.app and a DMG in src-tauri/target/release/bundle
```

A release, signed with the Developer ID, notarized and stapled, comes from
[scripts/release-mac.sh](scripts/release-mac.sh); it says at its top what it needs once per Mac.

The full design is written up in [docs/spec/v1.md](docs/spec/v1.md).

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) says how to build Dictate
and what a pull request needs. Report a security problem privately, as [SECURITY.md](SECURITY.md) explains.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The speech models and libraries it uses are listed with their licenses
in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
