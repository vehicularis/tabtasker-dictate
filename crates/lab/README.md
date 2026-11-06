# dictate-lab

The lab runs TabTasker Dictate's speech pipeline without the app. It hears a recording one stage at a time and shows what each stage made of it:
- the gate;
- the language;
- Whisper's words;
- the text rules;
- what a typing mode does next with a spoken sticky or "send".

It then scores the words against what was said. Its fixtures are the regression test for recognition: `eval` fails when a fixture's word error rate goes over its budget.

The stages are the engine's own (`crates/engine`), driven the way `src-tauri/src/dictation/speech.rs` drives them. The lab never launches the app, and never reads or writes the app's folders.

Run it from the repo root:

```
cargo run -p dictate-lab --release -- <command>
```

or build it once and use `target/release/dictate-lab`. The examples below write `dictate-lab` for either. `dictate-lab --help` lists every flag.

## Commands

Every command takes these flags:
- `--json` prints one JSON document on stdout and nothing else there (`eval` also writes its table to stderr);
- `--models DIR` names the models folder;
- `--help` prints the usage.

### text

The text rules alone, on a raw transcript. No model is needed.

```
$ dictate-lab text "um so can you send me the notes" --style formal --fillers
So can you send me the notes.
```

### fetch

Downloads Whisper (`--model small`, the default, or `turbo`) and the speech detection, and checks them. With `--speakers` it also gets the speaker models. When the files are already there and check out, it prints only the last line.

```
$ dictate-lab fetch --model small
models are in /Users/you/tabtasker-dictate/target/models: ggml-small-q8_0.bin, ggml-silero-v6.2.0.bin
```

### run

Hears 16 kHz mono WAV files stage by stage. It takes the settings a hold would have: `--language auto|CODE`, `--translate`, `--words "A, B"`, `--style`, `--fillers`. `--note` hears each file piece by piece, as a long note is.

```
$ dictate-lab run target/fixtures/vocabulary.wav --words "TabTasker, Vehicularis"
file: target/fixtures/vocabulary.wav, 3.11 s
gate: speech ends at 3.01 s (1 segment, peak 0.7738, loudest rms 0.2378)
language: en, detected, 0.99 sure
whisper: "TabTasker ships the Vehicularis build on Friday." (vocabulary retry: no)
typed: "TabTasker ships the Vehicularis build on Friday."
spoken: types "TabTasker ships the Vehicularis build on Friday.", no send
times: gate 8 ms, language 89 ms, whisper 151 ms
```

`spoken:` is what the app does after the text rules. "Sticky: call Thomas" puts a sticky on screen and types nothing. A spoken "send" at the end is taken off, and Return follows the words:

```
spoken: sticky "Call Thomas about the venue.", types nothing
spoken: types "Thanks. Maria. See you tomorrow morning.", then sends
```

`run` exits 1 when a stage fails on any file, or a note skips a piece.

### fixtures

Renders the fixtures in `crates/lab/fixtures` into `target/fixtures` (or `--out DIR`), each WAV beside a copy of its JSON. Spoken fixtures are rendered with macOS `say`:

```
say -v VOICE -o OUT.wav --file-format=WAVE --data-format=LEI16@16000 TEXT
```

Silence and noise are synthesized; the noise is seeded, so it is the same on every machine. A fixture whose voice isn't installed on this Mac is skipped, and the skip is printed. `say -v '?'` lists the voices you have.

```
$ dictate-lab fixtures
code: said by Samantha, 5.60 s
fillers: said by Samantha, 4.54 s
german: said by Anna, 3.54 s
noise: synthesized noise, 3.00 s
note: said by Samantha, 39.20 s
numbers: said by Samantha, 5.03 s
plain: said by Samantha, 4.64 s
question: said by Samantha, 2.82 s
send: said by Samantha, 4.03 s
silence: synthesized silence, 3.00 s
sticky: said by Samantha, 2.46 s
turkish: said by Yelda, 4.21 s
vocabulary: said by Samantha, 3.11 s
13 fixtures in /Users/you/tabtasker-dictate/target/fixtures: 13 rendered, 0 skipped
```

### eval

Hears every `x.wav` beside an `x.json` in a folder (`target/fixtures` unless you name one) through `run`'s stages, with the JSON's settings. Each fixture gets one row, then the mean word error rate (WER) and the counts.

```
$ dictate-lab eval --model small
code: pass, WER 0.000 (budget 0.05), 199 ms, heard "firstName = getFirstName();", expected "firstName = getFirstName();"
fillers: pass, WER 0.000 (budget 0.05), 179 ms, heard "So, I think we should move the launch to next week.", expected "So, I think we should move the launch to next week."
german: pass, WER 0.000 (budget 0.05), 239 ms, heard "Wir treffen uns morgen früh im großen Besprechungsraum.", expected "Wir treffen uns morgen früh im großen Besprechungsraum."
noise: pass, WER 0.000 (budget 0.00), 7 ms, heard nothing, expected nothing
note: pass, WER 0.000 (budget 0.05), 1086 ms, heard "Here is the plan for next week. On Monday we review the ...", expected "Here is the plan for next week. On Monday we review the ..."
numbers: pass, WER 0.000 (budget 0.05), 196 ms, heard "We booked three rooms for 12 people on June 14th, at 7.30 in the evening.", expected "We booked three rooms for 12 people on June 14th at 7.30 in the evening."
plain: pass, WER 0.000 (budget 0.05), 265 ms, heard "The meeting moved to Thursday afternoon, so we have more time to finish the report.", expected "The meeting moved to Thursday afternoon, so we have more time to finish the report."
question: pass, WER 0.000 (budget 0.05), 154 ms, heard "Do you know where we put the spare keys for the office?", expected "Do you know where we put the spare keys for the office?"
send: pass, WER 0.000 (budget 0.05), 149 ms, heard "Thanks. Maria. See you tomorrow morning. Send.", expected "Thanks, Maria, see you tomorrow morning. Send."
silence: pass, WER 0.000 (budget 0.00), 0 ms, heard nothing, expected nothing
sticky: pass, WER 0.000 (budget 0.05), 140 ms, heard "Sticky. Call Thomas about the venue.", expected "Sticky, call Thomas about the venue."
turkish: pass, WER 0.000 (budget 0.05), 258 ms, heard "Yarın sabah toplantıdan önce raporu bitirmemiz gerekiyor.", expected "Yarın sabah toplantıdan önce raporu bitirmemiz gerekiyor."
vocabulary: pass, WER 0.000 (budget 0.05), 152 ms, heard "TabTasker ships the Vehicularis build on Friday", expected "TabTasker ships the Vehicularis build on Friday."
mean WER 0.000 over 11 fixtures with words
13 fixtures: 13 passed, 0 over budget, 0 mismatched, 0 skipped, 0 errors
```

(The note's 120 words are cut short here.)

WER is (substitutions + deletions + insertions) / words said. Both sides are compared lowercase and without punctuation, so "Thanks. Maria." scores the same as "Thanks, Maria,". It scores the words after the text rules, the `typed:` line of `run`.

Because WER can't see case or symbols, a fixture can also give `expect_typed`, the exact text the app should type. Case and punctuation count there, and only the whitespace at either end is trimmed. That is how the Code and Formal fixtures check `firstName = getFirstName();` and a closing full stop, not just their words:

```
code: mismatch, typed "username = get user(id);", expected exactly "userName = get user(ID);", WER 0.000 (budget 0.05), 191 ms, heard "username = get user(id);", expected "userName = get user(ID);"
```

A row's verdict is one of:
- `pass`;
- `over budget`: the WER is over the fixture's `max_wer`;
- `mismatch`: the words are within budget, but the exact text, the sticky or the send isn't the one expected;
- `skipped`: there is no WAV beside the JSON, as when its voice isn't installed;
- `error`: a stage failed, or a note skipped a piece.

`eval` exits 1 when a fixture is over budget, mismatched or errors. A skipped fixture is neither a pass nor a failure. `--json` prints every row with its full trace, then `mean_wer`, `with_words` and `counts`, as one document on stdout. The table above goes to stderr then, so `dictate-lab eval --json > eval.json 2> table.txt` keeps both from one run.

## Where things go

- **Models** go in the folder `--models` or `DICTATE_MODELS` names. Without either, they go in `<repo>/target/models`.
- **Rendered fixtures** go in `<repo>/target/fixtures`, or the `--out` folder.
- **The fixtures themselves** are JSON in `crates/lab/fixtures`.

The lab refuses the app's own folders for all of these:
- `~/Library/Application Support/com.tabtasker.dictate`;
- `~/Documents/TabTasker Dictate`;
- `~/Library/Logs/TabTasker Dictate`.

## A fixture's JSON

```json
{
  "say": "Sticky: call Thomas about the venue.",
  "voice": "Samantha",
  "expect": "Sticky, call Thomas about the venue.",
  "language": "en",
  "expect_sticky": "Call Thomas about the venue.",
  "max_wer": 0.05
}
```

Every field is optional, and a field the lab doesn't know is refused, so a typo can't pass unseen.

| Field | Meaning |
|---|---|
| `say`, `voice` | What `say` reads aloud, and in which voice. |
| `synth` | `silence` or `noise`, three seconds of each, instead of `say`. |
| `expect` | The words that should be typed. |
| `expect_typed` | The exact text that should be typed, after a spoken sticky or send: case and punctuation count. Unchecked when absent. |
| `expect_unheard` | `true` when nothing should be typed at all. |
| `expect_sticky` | The words a spoken sticky should hold. Unchecked when absent. |
| `expect_send` | Whether a spoken "send" should end the words. Unchecked when absent. |
| `language` | `auto` (the default) or a code such as `de`. |
| `words` | The vocabulary, as Settings holds it. |
| `style` | `default`, `casual`, `formal`, `code` or `raw`. |
| `fillers` | `true` drops "um" and "uh". |
| `note` | `true` hears it piece by piece, as a long note. |
| `max_wer` | Its budget: the highest WER that still passes. `0` when absent. |

Write `expect` the way Whisper writes it: "three rooms for 12 people on June 14th at 7.30", not the way it was typed for `say`. Set a new fixture's `max_wer` from a real run with Small: its WER rounded up to the next 0.05, and at least 0.05.

## Scoring your own recordings

`eval` takes any folder of `x.wav` and `x.json` pairs, so recordings of your own voice can be scored the same way. Keep them out of the repo. Convert each recording to 16 kHz mono WAV first:

```
afconvert -f WAVE -d LEI16@16000 -c 1 memo.m4a ~/lab-recordings/memo.wav
```

Beside it, write `memo.json` with what you said:

```json
{ "expect": "Remind me to call the dentist on Monday.", "language": "auto", "max_wer": 0.1 }
```

Then score the folder:

```
$ dictate-lab eval ~/lab-recordings
memo: pass, WER 0.000 (budget 0.10), 232 ms, heard "Remind me to call the dentist on Monday.", expected "Remind me to call the dentist on Monday."
mean WER 0.000 over 1 fixture with words
1 fixture: 1 passed, 0 over budget, 0 mismatched, 0 skipped, 0 errors
```

`run` and `eval` refuse a WAV that isn't 16 kHz mono, and print the `afconvert` line that converts it.

## Why no audio is committed

The macOS licence limits what the output of Apple's voices may be used for. So the fixtures commit only their text and settings, and their audio is rendered with `say` on the machine that runs them, into `target/`, which git ignores. Keep your own recordings out of the repo too.
