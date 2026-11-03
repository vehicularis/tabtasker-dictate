//! The dictate key's taps, holds, chords and session limits, and how words go in (keys.m), driven with
//! numbers: no event is ever posted.
use dictate_lib as _; // links the native code these come from
use std::ffi::{c_char, CStr};

#[repr(C)]
#[derive(Default)]
struct Taps { down_at: f64, tap_at: f64, down: bool, tapped: bool }

const FN: u32 = 0;
const RIGHT_COMMAND: u32 = 1;
const RIGHT_OPTION: u32 = 2;
const RIGHT_CONTROL: u32 = 3;
const RIGHT_SHIFT: u32 = 4;
const SHIFT: u64 = 1 << 17;
const CONTROL: u64 = 1 << 18;
const OPTION: u64 = 1 << 19;
const COMMAND: u64 = 1 << 20;
const FUNCTION: u64 = 1 << 23;
const CAPS_LOCK: u64 = 1 << 16;
const PLAIN: i32 = 0;
const TO_CLAUDE: i32 = 1;
const SHORTCUT: i32 = 2;
const NONE: i32 = 0;
const SINGLE: i32 = 1;
const DOUBLE: i32 = 2;

extern "C" {
  fn tt_key_code(key: u32) -> u16;
  fn tt_key_down(key: u32, flags: u64) -> bool;
  fn tt_key_others(key: u32, flags: u64) -> u64;
  fn tt_hold_kind(others: u64, command: u64) -> i32;
  fn tt_taps_press(taps: *mut Taps, now: f64);
  fn tt_taps_release(taps: *mut Taps, now: f64) -> i32;
  fn tt_taps_reset(taps: *mut Taps);
  fn tt_chord_matches(key_code: u16, flags: u64, chord_key: u16, chord_modifiers: u64) -> bool;
  fn tt_taps_size() -> usize;
  fn tt_hold_limit(long_session: bool) -> usize;
  fn tt_words_timeout(samples: usize) -> f64;
  fn tt_types_instead(chromium: bool, plain_layout: bool, characters: usize, units: usize, one_line: bool) -> bool;
  fn tt_typed_browser(bundle_id: *const c_char) -> bool;
  fn tt_type_chunks(lengths: *const usize, count: usize, ends: *mut usize) -> usize;
  fn tt_send_delay(how: i32) -> f64;
  fn tt_restore_at(pressed_at: f64, read_at: f64) -> f64;
  fn tt_paste_step(now: f64, pressed_at: f64, read_at: f64, ours: bool, latest: bool) -> i32;
  fn tt_release_tail(quiet_for: f64) -> f64;
  fn tt_retap_delay(failed: u32) -> f64;
  fn tt_capture_stalled(running_for: f64, buffers: usize, peak: f64) -> bool;
  fn tt_globe_step(want: bool, owned: bool, current: i32, launch: bool) -> i32;
}

fn code(key: u32) -> u16 { unsafe { tt_key_code(key) } }
fn down(key: u32, flags: u64) -> bool { unsafe { tt_key_down(key, flags) } }
fn others(key: u32, flags: u64) -> u64 { unsafe { tt_key_others(key, flags) } }
fn kind(others: u64, command: u64) -> i32 { unsafe { tt_hold_kind(others, command) } }
fn chord(key_code: u16, flags: u64, chord_key: u16, chord_modifiers: u64) -> bool { unsafe { tt_chord_matches(key_code, flags, chord_key, chord_modifiers) } }

/// Presses and releases at the given times, answering what each release made.
fn taps(times: &[(f64, f64)]) -> Vec<i32> {
  let mut taps = Taps::default();
  times.iter().map(|&(press, release)| unsafe { tt_taps_press(&mut taps, press); tt_taps_release(&mut taps, release) }).collect()
}

#[test]
fn the_state_matches_its_c_layout() {
  assert_eq!(unsafe { tt_taps_size() }, std::mem::size_of::<Taps>());
}

#[test]
fn each_key_has_its_code() {
  assert_eq!([FN, RIGHT_COMMAND, RIGHT_OPTION, RIGHT_CONTROL, RIGHT_SHIFT].map(code), [63, 54, 61, 62, 60]);
  assert_eq!(code(99), 63); // an unknown key is fn
}

#[test]
fn a_right_hand_key_is_told_apart_from_its_left_twin() {
  assert!(down(FN, FUNCTION));
  assert!(!down(FN, CONTROL));
  assert!(down(RIGHT_COMMAND, COMMAND | 0x10));
  assert!(!down(RIGHT_COMMAND, COMMAND | 0x08)); // left ⌘ only
  assert!(down(RIGHT_COMMAND, COMMAND | 0x08 | 0x10));
  assert!(down(RIGHT_OPTION, OPTION | 0x40));
  assert!(!down(RIGHT_OPTION, OPTION | 0x20));
  assert!(down(RIGHT_CONTROL, CONTROL | 0x2000));
  assert!(!down(RIGHT_CONTROL, CONTROL | 0x01));
  assert!(down(RIGHT_SHIFT, SHIFT | 0x04));
  assert!(!down(RIGHT_SHIFT, SHIFT | 0x02));
  assert!(!down(RIGHT_SHIFT, 0x04)); // a stale side bit without the flag is a release
  assert!(down(RIGHT_COMMAND, COMMAND)); // no side bits at all: the flag decides
}

#[test]
fn other_modifiers_leave_out_the_key_itself() {
  assert_eq!(others(FN, FUNCTION), 0);
  assert_eq!(others(FN, FUNCTION | CONTROL | CAPS_LOCK), CONTROL);
  assert_eq!(others(RIGHT_COMMAND, COMMAND | 0x10), 0);
  assert_eq!(others(RIGHT_COMMAND, COMMAND | 0x10 | 0x08), COMMAND); // both ⌘ keys
  assert_eq!(others(RIGHT_COMMAND, COMMAND | 0x10 | OPTION | 0x20), OPTION);
  assert_eq!(others(RIGHT_SHIFT, SHIFT | 0x04 | CONTROL | 0x01), CONTROL);
  assert_eq!(others(RIGHT_CONTROL, CONTROL | 0x2000 | 0x01), CONTROL);
}

#[test]
fn the_command_modifier_alone_talks_to_claude() {
  assert_eq!(kind(0, CONTROL), PLAIN);
  assert_eq!(kind(CONTROL, CONTROL), TO_CLAUDE);
  assert_eq!(kind(CONTROL | SHIFT, CONTROL), SHORTCUT);
  assert_eq!(kind(OPTION, CONTROL), SHORTCUT);
  assert_eq!(kind(CONTROL, 0), SHORTCUT); // commands off
  assert_eq!(kind(0, 0), PLAIN);
}

#[test]
fn two_quick_taps_lock_and_anything_slower_does_not() {
  assert_eq!(taps(&[(0.0, 0.1), (0.3, 0.4)]), [SINGLE, DOUBLE]);
  assert_eq!(taps(&[(0.0, 0.1), (0.35, 0.45)]), [SINGLE, DOUBLE]); // presses 0.35 s apart
  assert_eq!(taps(&[(0.0, 0.1), (0.36, 0.4)]), [SINGLE, SINGLE]); // too far apart: a new first tap
  assert_eq!(taps(&[(0.0, 0.25), (0.3, 0.35)]), [NONE, SINGLE]); // the first was a hold
  assert_eq!(taps(&[(0.0, 0.1), (0.2, 0.5)]), [SINGLE, NONE]); // tap, then hold to talk
  assert_eq!(taps(&[(0.0, 0.1), (0.2, 0.3), (0.4, 0.5)]), [SINGLE, DOUBLE, SINGLE]); // a third starts over
  assert_eq!(taps(&[(0.0, 2.0), (2.1, 2.2), (2.3, 2.4)]), [NONE, SINGLE, DOUBLE]);
}

#[test]
fn a_reset_or_a_stray_release_breaks_a_double_tap() {
  let mut state = Taps::default();
  unsafe {
    assert_eq!(tt_taps_release(&mut state, 1.0), NONE); // a release never pressed
    tt_taps_press(&mut state, 1.0);
    assert_eq!(tt_taps_release(&mut state, 1.1), SINGLE);
    tt_taps_reset(&mut state); // a key typed in between
    tt_taps_press(&mut state, 1.2);
    assert_eq!(tt_taps_release(&mut state, 1.3), SINGLE);
  }
}

#[test]
fn a_hold_runs_five_minutes_a_locked_session_ten_and_their_words_get_the_time_to_match() {
  let minute = 60 * 16000;
  unsafe {
    assert_eq!(tt_hold_limit(false), 5 * minute);
    assert_eq!(tt_hold_limit(true), 10 * minute);
    assert_eq!(tt_words_timeout(0), 120.0);
    assert_eq!(tt_words_timeout(minute), 120.0); // a short hold keeps its two minutes
    assert_eq!(tt_words_timeout(5 * minute), 600.0);
    assert_eq!(tt_words_timeout(10 * minute), 1200.0);
  }
}

#[test]
fn a_chord_matches_its_key_and_exact_modifiers() {
  let (n, option_command) = (45, OPTION | COMMAND);
  assert!(chord(n, option_command, n, option_command));
  assert!(chord(n, option_command | CAPS_LOCK | FUNCTION | 0x08 | 0x20, n, option_command)); // side bits and locks don't count
  assert!(!chord(n, option_command | SHIFT, n, option_command));
  assert!(!chord(n, COMMAND, n, option_command));
  assert!(!chord(46, option_command, n, option_command));
  assert!(chord(96, FUNCTION, 96, 0)); // F5 alone, with fn held for it
}

#[test]
fn words_are_pasted_except_one_line_into_a_chromium_browser_on_a_plain_layout() {
  unsafe {
    assert!(tt_types_instead(true, true, 40, 40, true), "Chrome, plain layout, one line: typed");
    assert!(!tt_types_instead(false, true, 40, 40, true), "anywhere else: pasted");
    assert!(!tt_types_instead(true, false, 40, 40, true), "an input method would compose the keys");
    assert!(!tt_types_instead(true, true, 40, 40, false), "a line break is pasted");
    assert!(!tt_types_instead(true, true, 1, 1, true), "one character would be a key press");
    assert!(!tt_types_instead(true, true, 1, 2, true), "so is one emoji, two units long");
    assert!(!tt_types_instead(true, true, 1, 11, true), "or a family of four");
    assert!(tt_types_instead(true, true, 2, 2, true), "two characters are text");
    assert!(tt_types_instead(true, true, 1500, 2000, true) && !tt_types_instead(true, true, 1500, 2001, true), "up to 2,000 units");
  }
}

fn browser(id: &CStr) -> bool { unsafe { tt_typed_browser(id.as_ptr()) } }

#[test]
fn a_chromium_browser_counts_with_its_channels_and_web_apps() {
  for id in [c"com.google.Chrome", c"com.google.Chrome.canary", c"com.google.Chrome.app.kjgfgldnnfoeklkmfkjfagphfepbbdan", c"org.chromium.Chromium",
    c"com.brave.Browser", c"com.brave.Browser.nightly", c"com.microsoft.edgemac", c"com.microsoft.edgemac.Dev", c"company.thebrowser.Browser",
    c"company.thebrowser.dia", c"com.vivaldi.Vivaldi", c"com.operasoftware.Opera", c"ai.perplexity.comet"] {
    assert!(browser(id), "{id:?}");
  }
  for id in [c"com.apple.Safari", c"com.google.Chromecast", c"com.google.ChromeX", c"org.mozilla.firefox", c"com.microsoft.edge", c"", c"com.google"] {
    assert!(!browser(id), "{id:?}");
  }
  assert!(!unsafe { tt_typed_browser(std::ptr::null()) });
}

/// The pieces characters of these UTF-16 lengths are typed in, as characters per piece.
fn chunks(lengths: &[usize]) -> Vec<usize> {
  let mut ends = vec![0; lengths.len()];
  let count = unsafe { tt_type_chunks(lengths.as_ptr(), lengths.len(), ends.as_mut_ptr()) };
  let mut start = 0;
  ends[..count].iter().map(|&end| { let size = end - start; start = end; size }).collect()
}

#[test]
fn typed_words_go_in_whole_characters_twenty_units_at_most_never_one_alone() {
  assert_eq!(chunks(&[]), Vec::<usize>::new());
  assert_eq!(chunks(&[1; 2]), [2]);
  assert_eq!(chunks(&[1; 40]), [20, 20]);
  assert_eq!(chunks(&[1; 41]), [20, 19, 2], "a last character alone takes one along");
  assert_eq!(chunks(&[1; 21]), [19, 2]);
  // 19 letters, then an emoji (2 units) that doesn't fit: it starts the next piece whole.
  let mut emoji = vec![1; 19];
  emoji.extend([2, 1, 1]);
  assert_eq!(chunks(&emoji), [19, 3]);
  assert_eq!(chunks(&[11, 11, 11]), [1, 1, 1], "one family emoji per piece, none split");
  assert_eq!(chunks(&[25]), [1], "a character longer than a piece goes alone");
  assert_eq!(chunks(&[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11]), [11, 1], "the last can't take one along past 20 units");
  for lengths in [vec![1; 41], emoji, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 1]] {
    let (mut start, mut ends) = (0, vec![0; lengths.len()]);
    let count = unsafe { tt_type_chunks(lengths.as_ptr(), lengths.len(), ends.as_mut_ptr()) };
    for &end in &ends[..count] {
      assert!(lengths[start..end].iter().sum::<usize>() <= 20 || end - start == 1, "{lengths:?}");
      start = end;
    }
    assert_eq!(start, lengths.len(), "every character goes in");
  }
}

const TYPED: i32 = 0;
const PASTED: i32 = 1;
const UNREAD: i32 = 2;
const WAIT: i32 = 0;
const RESTORE: i32 = 1;
const DONE: i32 = 2;
const LEFT: i32 = 3;
const LOST: i32 = 4;

fn step(now: f64, read_at: f64, ours: bool, latest: bool) -> i32 { unsafe { tt_paste_step(now, 10.0, read_at, ours, latest) } }

#[test]
fn the_clipboard_goes_back_once_the_paste_is_read_and_only_by_the_last_paste() {
  unsafe {
    assert_eq!(tt_restore_at(10.0, 0.0), 10.45, "not read yet: 450 ms after the paste");
    assert_eq!(tt_restore_at(10.0, 10.1), 10.45, "read quickly: still 450 ms");
    assert!((tt_restore_at(10.0, 11.0) - 11.05).abs() < 1e-9, "read late: 50 ms after the read");
  }
  assert_eq!(step(10.1, 0.0, true, true), WAIT, "not read yet");
  assert_eq!(step(10.2, 10.1, true, true), WAIT, "read, but too soon after ⌘V");
  assert_eq!(step(10.46, 10.1, true, true), RESTORE);
  assert_eq!(step(10.46, 10.1, false, true), DONE, "copied something since: that stays");
  assert_eq!(step(10.46, 10.1, true, false), DONE, "a newer paste gives it back instead");
  assert_eq!(step(10.2, 0.0, false, false), LOST, "replaced unread by a newer paste");
  assert_eq!(step(10.2, 0.0, false, true), LOST, "replaced unread by a copy");
  assert_eq!(step(12.9, 0.0, true, true), WAIT);
  assert_eq!(step(13.1, 0.0, true, true), LEFT, "never read: the words stay to paste");
}

#[test]
fn return_follows_typed_or_pasted_words_never_an_unread_paste() {
  unsafe {
    assert_eq!(tt_send_delay(TYPED), 0.03);
    assert_eq!(tt_send_delay(PASTED), 0.03);
    assert!(tt_send_delay(UNREAD) < 0.0);
  }
}

#[test]
fn a_release_waits_only_as_long_as_the_end_of_speech_may_still_be_arriving() {
  unsafe {
    assert_eq!(tt_release_tail(0.0), 0.3, "still talking, or nothing heard yet");
    assert!((tt_release_tail(0.1) - 0.2).abs() < 1e-9);
    assert_eq!(tt_release_tail(0.3), 0.0, "already quiet long enough");
    assert_eq!(tt_release_tail(5.0), 0.0);
    assert_eq!(tt_release_tail(-1.0), 0.3);
  }
}

#[test]
fn a_microphone_that_changed_is_tried_again_four_times_then_given_up() {
  unsafe {
    assert_eq!([0, 1, 2, 3, 4, 5, 9].map(|failed| tt_retap_delay(failed)), [0.0, 0.15, 0.3, 0.6, 1.2, 0.0, 0.0]);
    assert!(!tt_capture_stalled(0.5, 0, 0.0), "a microphone may take a moment");
    assert!(tt_capture_stalled(0.8, 0, 0.0), "nothing arrived");
    assert!(tt_capture_stalled(0.8, 7, 0.0), "only exact silence arrived");
    assert!(!tt_capture_stalled(0.8, 7, 0.0001), "a quiet room is still sound");
  }
}

const NOTHING: i32 = 0;
const TAKE: i32 = 1;
const GIVE_BACK: i32 = 2;
const FORGET: i32 = 3;
const DO_NOTHING: i32 = 0;
const EMOJI: i32 = 2;

fn globe(want: bool, owned: bool, current: i32, launch: bool) -> i32 { unsafe { tt_globe_step(want, owned, current, launch) } }

#[test]
fn the_globe_key_is_held_at_do_nothing_while_fn_dictates_and_given_back_after() {
  assert_eq!(globe(true, false, EMOJI, false), TAKE, "fn dictates and the globe does something");
  assert_eq!(globe(true, false, DO_NOTHING, false), NOTHING, "already does nothing");
  assert_eq!(globe(false, false, EMOJI, false), NOTHING, "another key, or paused: never ours to change");
  assert_eq!(globe(true, true, DO_NOTHING, false), NOTHING, "already held");
  assert_eq!(globe(false, true, DO_NOTHING, false), GIVE_BACK, "the key changed, dictation paused or the app quit");
  assert_eq!(globe(false, true, EMOJI, false), FORGET, "changed in System Settings since: theirs stays");
  assert_eq!(globe(true, true, EMOJI, false), NOTHING, "changed while it runs: theirs stays for now");
}

#[test]
fn a_globe_original_left_over_at_launch_is_given_back_or_kept() {
  assert_eq!(globe(false, true, DO_NOTHING, true), GIVE_BACK, "fn isn't the key, or dictation is paused");
  assert_eq!(globe(false, true, EMOJI, true), FORGET, "chosen since the last run ended");
  assert_eq!(globe(true, true, DO_NOTHING, true), NOTHING, "fn still dictates: still held, still saved");
  assert_eq!(globe(true, true, EMOJI, true), FORGET, "chosen since: forgotten, then taken again from there");
  assert_eq!(globe(true, false, EMOJI, true), TAKE);
}
