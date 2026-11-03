// Plain C (this is a .m only so build.rs compiles it): see keys.h.
#include "keys.h"
#include <string.h>

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

size_t tt_hold_limit(bool long_session) { return (long_session ? 10 : 5) * 60 * 16000; }

// Two minutes, or twice as long as it took to say: the speed a one-minute hold always needed, so a long
// hold, or a ten-minute session whose tail is still untranscribed, gets the time it needs too.
double tt_words_timeout(size_t samples) { double said = samples / 16000.0; return said * 2 > 120 ? said * 2 : 120; }

bool tt_types_instead(bool chromium, bool plain_layout, size_t characters, size_t units, bool one_line) {
  return chromium && plain_layout && one_line && characters > 1 && units <= 2000;
}

bool tt_typed_browser(const char *bundle_id) {
  static const char *const browsers[] = { "com.google.Chrome", "org.chromium.Chromium", "com.brave.Browser", "com.microsoft.edgemac",
    "company.thebrowser.Browser", "company.thebrowser.dia", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "ai.perplexity.comet" };
  if (!bundle_id) return false;
  for (size_t i = 0; i < sizeof browsers / sizeof *browsers; i++) {
    size_t length = strlen(browsers[i]);
    if (!strncmp(bundle_id, browsers[i], length) && (bundle_id[length] == 0 || bundle_id[length] == '.')) return true;
  }
  return false;
}

size_t tt_type_chunks(const size_t *lengths, size_t count, size_t *ends) {
  size_t chunks = 0, units = 0;
  for (size_t i = 0; i < count; i++) {
    if (chunks && units + lengths[i] <= TT_CHUNK) units += lengths[i];
    else { chunks++; units = lengths[i]; }
    ends[chunks - 1] = i + 1;
  }
  if (chunks > 1 && ends[chunks - 1] - ends[chunks - 2] == 1) {
    size_t before = chunks > 2 ? ends[chunks - 3] : 0; // where the piece before the last starts
    if (ends[chunks - 2] - before > 1 && lengths[count - 2] + lengths[count - 1] <= TT_CHUNK) ends[chunks - 2]--;
  }
  return chunks;
}

// A moment for the app to take in what was typed or pasted, so Return lands after it.
double tt_send_delay(TTInserted how) { return how == TTInsertUnread ? -1 : 0.03; }

double tt_restore_at(double pressed_at, double read_at) {
  double after_press = pressed_at + 0.45;
  return read_at > 0 && read_at + 0.05 > after_press ? read_at + 0.05 : after_press;
}

TTPasteStep tt_paste_step(double now, double pressed_at, double read_at, bool ours, bool latest) {
  if (read_at > 0) {
    if (!ours || !latest) return TTPasteDone;
    return now >= tt_restore_at(pressed_at, read_at) ? TTPasteRestore : TTPasteWait;
  }
  if (!ours) return TTPasteLost;
  return now - pressed_at > 3 ? TTPasteUnread : TTPasteWait;
}

double tt_release_tail(double quiet_for) { return quiet_for >= 0.3 ? 0 : quiet_for > 0 ? 0.3 - quiet_for : 0.3; }

double tt_retap_delay(unsigned failed) { return failed >= 1 && failed <= 4 ? 0.15 * (1u << (failed - 1)) : 0; }

// 0.7 s is past a working microphone's first buffer (100 ms) by far, and short of losing a first sentence.
bool tt_capture_stalled(double running_for, size_t buffers, double peak) { return running_for > 0.7 && (!buffers || peak <= 0); }

TTGlobe tt_globe_step(bool want, bool owned, int current, bool launch) {
  if (!owned) return want && current != 0 ? TTGlobeTake : TTGlobeNothing;
  if (!want) return current == 0 ? TTGlobeRestore : TTGlobeForget; // only our own Do Nothing goes back
  // Already held: nothing to do, unless a run that never gave it back left it and the person chose since,
  // which is the original from now on (taken again from there).
  return launch && current != 0 ? TTGlobeForget : TTGlobeNothing;
}
