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
// The 16 kHz samples a session may hold: a minute for a hold, ten for a locked session or a note's audio
// not yet transcribed.
size_t tt_hold_limit(bool long_session);
// Seconds the words of `samples` may take before the overlay gives up on them.
double tt_words_timeout(size_t samples);

// Our own key events carry this in kCGEventSourceUserData, so the key monitor never takes them for the person's.
#define TT_VOICE_MARK 0x74747663

// Putting the words in, as OpenWhispr does: pasted, except in a Chromium browser (it drops a synthetic ⌘V now
// and then), where they are typed if the keyboard is a plain layout (an input method would compose the keys)
// and they are one line of 2 to 2,000 UTF-16 units.
bool tt_types_instead(bool chromium, bool plain_layout, size_t units, bool one_line);
// When the clipboard goes back to what it held: 450 ms after ⌘V, or 50 ms after the app read the words
// (`read_at`, 0 while it hasn't), whichever is later. Seconds, on the clock `pressed_at` is on.
double tt_restore_at(double pressed_at, double read_at);

#endif
