# Changelog

What changed in each release of TabTasker | Dictate, newest first. Every release, with its signed and
notarized DMG, is on the [releases page](https://github.com/vehicularis/tabtasker-dictate/releases).

## Unreleased

### Added

- Dictate updates itself. Every few hours it looks for a new release, downloads it in the background and
  offers to restart, never while you’re dictating or recording a meeting. Turn it off or check now in
  Settings › General, or choose Check for updates… in the pill’s menu or the menu bar.
- Every release is built in the open by a GitHub workflow, with a SHA256SUMS file and an attestation that
  says which commit and workflow built the DMG. The README says how to check a download with them.

### Fixed

- A ticked task in a note shows its tick at night, where it was a plain white dot.
- Opening a note from the list no longer flashes “That file isn’t there any more” first.

## [0.1.1] - 2026-11-05

### Added

- Typing as you talk. Hold fn and your words appear in the field as you say them, and the finished text
  replaces them when you let go. Click or type yourself and it leaves the field to you; press Escape and it
  takes them back.
- Size in the pill’s menu. Right-click the pill to make it small, medium or large.
- Speak a note from Notes. The Notes window has its own button for it.

### Changed

- A clearer setup. Every step is numbered down the left, with what to do and Continue right under it, and a
  checklist of what’s ready at the end.
- A one-line hands-free bar.

### Fixed

- Saying one word again and again no longer turns into a page of it.

## [0.1.0] - 2026-11-04

The first release: hold fn in any app, say what you want to write, and let go.

- Dictation in any app, in more than 40 languages, turned into text on your Mac. Say “send” at the end and it
  presses Return.
- Notes you can talk or type, saved as plain Markdown files in a folder you choose.
- Stickies that stay on top of your windows. Hold fn and start with “sticky” to make one by voice.
- Meeting recordings that tell the voices apart, with a summary if you connect AI.
- AI only if you want it: Claude, OpenAI, any OpenAI-compatible service, or a model on your Mac.

[0.1.1]: https://github.com/vehicularis/tabtasker-dictate/releases/tag/v0.1.1
[0.1.0]: https://github.com/vehicularis/tabtasker-dictate/releases/tag/v0.1.0
