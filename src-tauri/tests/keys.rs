//! The dictate key's taps, holds, chords and session limits (keys.m), driven with numbers: no event is
//! ever posted.
use dictate_lib as _; // links the native code these come from

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
fn a_locked_session_runs_ten_minutes_and_its_words_get_the_time_to_match() {
  let minute = 60 * 16000;
  unsafe {
    assert_eq!(tt_hold_limit(false), minute);
    assert_eq!(tt_hold_limit(true), 10 * minute);
    assert_eq!(tt_words_timeout(0), 120.0);
    assert_eq!(tt_words_timeout(minute), 120.0); // a hold keeps its two minutes
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
