// Plain C (this is a .m only so build.rs compiles it): see keys.h.
#include "keys.h"

enum { Shift = 1 << 17, Control = 1 << 18, Option = 1 << 19, Command = 1 << 20, Function = 1 << 23 };
static const uint64_t Modifiers = Shift | Control | Option | Command;

// Each key's code, its modifier flag, and the device bits for its family's left and right keys
// (IOLLEvent.h's NX_DEVICE*KEYMASK). fn has one key, so no sides.
static const struct { uint16_t code; uint64_t flag, left, right; } Keys[] = {
  [TTKeyFn] = { 63, Function, 0, 0 },
  [TTKeyRightCommand] = { 54, Command, 0x08, 0x10 },
  [TTKeyRightOption] = { 61, Option, 0x20, 0x40 },
  [TTKeyRightControl] = { 62, Control, 0x01, 0x2000 },
  [TTKeyRightShift] = { 60, Shift, 0x02, 0x04 },
};
static TTKey known(TTKey key) { return (unsigned)key <= TTKeyRightShift ? key : TTKeyFn; }

uint16_t tt_key_code(TTKey key) { return Keys[known(key)].code; }

// From an event for the key's own code.
bool tt_key_down(TTKey key, uint64_t flags) {
  key = known(key);
  if (!(flags & Keys[key].flag)) return false;
  if (!Keys[key].right) return true;
  // Without side bits (a virtual keyboard) the family's flag is all there is to go on.
  return (flags & Keys[key].right) || !(flags & Keys[key].left);
}

// The modifiers held besides the key itself; its own family counts only from the left side.
uint64_t tt_key_others(TTKey key, uint64_t flags) {
  key = known(key);
  uint64_t others = flags & Modifiers & ~Keys[key].flag;
  if (Keys[key].left && (flags & Keys[key].flag) && (flags & Keys[key].left)) others |= Keys[key].flag;
  return others;
}

// `command` is the modifier that talks to Claude, or 0 when that is off.
TTHold tt_hold_kind(uint64_t others, uint64_t command) {
  if (!others) return TTHoldPlain;
  return command && others == command ? TTHoldCommand : TTHoldShortcut;
}

void tt_taps_press(TTTaps *taps, double now) { taps->down = true; taps->downAt = now; }

TTTap tt_taps_release(TTTaps *taps, double now) {
  if (!taps->down) return TTTapNone;
  taps->down = false;
  if (now - taps->downAt >= TT_TAP) { taps->tapped = false; return TTTapNone; } // a hold
  if (taps->tapped && taps->downAt - taps->tapAt <= TT_DOUBLE_TAP) { taps->tapped = false; return TTTapDouble; }
  taps->tapped = true; taps->tapAt = taps->downAt;
  return TTTapSingle;
}

void tt_taps_reset(TTTaps *taps) { taps->down = false; taps->tapped = false; }

// Caps Lock, fn (which arrows and F-keys carry) and the keypad bit never change which chord it is.
bool tt_chord_matches(uint16_t key_code, uint64_t flags, uint16_t chord_key, uint64_t chord_modifiers) {
  return key_code == chord_key && (flags & Modifiers) == chord_modifiers;
}

size_t tt_taps_size(void) { return sizeof(TTTaps); }

size_t tt_hold_limit(bool long_session) { return (long_session ? 10 : 1) * 60 * 16000; }

// Two minutes, or twice as long as it took to say: the speed a one-minute hold always needed, so a
// ten-minute session whose tail is still untranscribed gets the time it needs too.
double tt_words_timeout(size_t samples) { double said = samples / 16000.0; return said * 2 > 120 ? said * 2 : 120; }
