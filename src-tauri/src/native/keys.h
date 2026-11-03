// The dictate key, its taps, the global chords and how long a session runs, as plain functions of an
// event's key code, flags and time, so they are tested without a single event. `flags` are NSEvent
// modifier flags, including the device-dependent bits macOS keeps in the low word for which side's key
// is down.
#ifndef TT_KEYS_H
#define TT_KEYS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// A press shorter than this is a tap; two taps whose presses start this close are a double tap.
#define TT_TAP 0.25
#define TT_DOUBLE_TAP 0.35

typedef enum { TTKeyFn, TTKeyRightCommand, TTKeyRightOption, TTKeyRightControl, TTKeyRightShift } TTKey;
// What other modifiers make of a hold: plain dictation, a command for Claude, or a shortcut to stay out of.
typedef enum { TTHoldPlain, TTHoldCommand, TTHoldShortcut } TTHold;
typedef enum { TTTapNone, TTTapSingle, TTTapDouble } TTTap;
// Zeroed, it has seen no press.
typedef struct { double downAt, tapAt; bool down, tapped; } TTTaps;

uint16_t tt_key_code(TTKey key);
bool tt_key_down(TTKey key, uint64_t flags);
uint64_t tt_key_others(TTKey key, uint64_t flags);
TTHold tt_hold_kind(uint64_t others, uint64_t command);
void tt_taps_press(TTTaps *taps, double now);
TTTap tt_taps_release(TTTaps *taps, double now);
void tt_taps_reset(TTTaps *taps);
bool tt_chord_matches(uint16_t key_code, uint64_t flags, uint16_t chord_key, uint64_t chord_modifiers);
size_t tt_taps_size(void);
// The 16 kHz samples a session may hold: five minutes for a hold, ten for a locked session or a note's audio
// not yet transcribed.
size_t tt_hold_limit(bool long_session);
// Seconds the words of `samples` may take before the overlay gives up on them.
double tt_words_timeout(size_t samples);

// Our own key events carry this in kCGEventSourceUserData, so the key monitor never takes them for the person's.
#define TT_VOICE_MARK 0x74747663

// Putting the words in, as OpenWhispr does: pasted, except in a Chromium browser (it drops a synthetic ⌘V now
// and then), where they are typed if the keyboard is a plain layout (an input method would compose the keys)
// and they are one line of at least 2 characters (one alone reaches the page as a key press, a site's
// shortcut) and at most 2,000 UTF-16 units.
bool tt_types_instead(bool chromium, bool plain_layout, size_t characters, size_t units, bool one_line);
// The Chromium browsers, by bundle id: their channels (com.google.Chrome.canary) and installed web apps
// (com.google.Chrome.app.<id>) too, which run as apps of their own under the browser's id.
bool tt_typed_browser(const char *bundle_id);
// Typed words go in pieces of whole characters of at most this many UTF-16 units (one key event carries 20).
#define TT_CHUNK 20
// Splits characters `lengths` (each one's UTF-16 units, `count` of them) into pieces of at most TT_CHUNK units,
// unless one character alone is longer. A single character left at the end takes the one before it along, as
// one alone would be a key press. Writes where each piece ends, in characters, to `ends` (room for `count`)
// and answers how many there are.
size_t tt_type_chunks(const size_t *lengths, size_t count, size_t *ends);

// How words went in: typed, pasted and read by the app, or never read (left on the clipboard to paste).
typedef enum { TTInsertTyped, TTInsertPasted, TTInsertUnread } TTInserted;
// Seconds after the words went in that Return follows them, or below 0 when it mustn't: never after a paste
// nobody read.
double tt_send_delay(TTInserted how);

// When the clipboard goes back to what it held: 450 ms after ⌘V, or 50 ms after the app read the words
// (`read_at`, 0 while it hasn't), whichever is later. Seconds, on the clock `pressed_at` is on.
double tt_restore_at(double pressed_at, double read_at);
// What a paste's wait does at `now`, ⌘V having gone at `pressed_at`: `ours` while the clipboard still holds our
// words, `latest` while no newer paste has taken over giving the clipboard back.
typedef enum {
  TTPasteWait,    // not read yet, or read but too soon to give the clipboard back
  TTPasteRestore, // read: give the clipboard back now
  TTPasteDone,    // read, and something newer is on the clipboard (or will put it back): leave it
  TTPasteUnread,  // nobody read it in 3 s: leave the words on the clipboard to paste
  TTPasteLost,    // replaced before anybody read it
} TTPasteStep;
TTPasteStep tt_paste_step(double now, double pressed_at, double read_at, bool ours, bool latest);

// What a 100 ms buffer at 16 kHz is louder than (RMS) while someone talks.
#define TT_SPEAKING 0.01
// Seconds to keep listening after the key comes up, when the sound has been below speech for `quiet_for`: the
// end of the last word is often still on its way, and sound quiet for 0.3 s already holds all of it.
double tt_release_tail(double quiet_for);
// Seconds before trying the microphone again when it has failed to start `failed` times in a row after it
// changed (150 ms, doubling), or 0 when it's time to give up.
double tt_retap_delay(unsigned failed);
// A microphone that has run `running_for` seconds and sent no buffers, or only silence that is exactly 0.
bool tt_capture_stalled(double running_for, size_t buffers, double peak);

// The globe key's own action ("Press 🌐 key to"), while fn dictates: `want` while the dictate key is fn and
// dictation is on, `owned` while the person's original is saved, `current` the action now (0: Do Nothing),
// `launch` once as the app starts (a saved original then is left over from a run that never gave it back).
typedef enum {
  TTGlobeNothing,
  TTGlobeTake,    // save the original, then set Do Nothing
  TTGlobeRestore, // set the original again and forget it
  TTGlobeForget,  // forget the original: the person has chosen since, and theirs stays
} TTGlobe;
TTGlobe tt_globe_step(bool want, bool owned, int current, bool launch);

#endif
