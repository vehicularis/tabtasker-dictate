#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include "keys.h"

extern void dictate_ui_notice(const char *message);

// Insert on Claude's answer card. A click on the card makes this app the active one, so keystrokes would
// land in the overlay: the app the command was spoken in has to be in front again before the answer is
// typed.

// On the main thread. True when the app with `bundle_id` is the front app; when it isn't and `activate`
// is set, asks it to come forward (it gets there a moment later). False when it isn't running.
bool dictate_claude_front(const char *bundle_id, bool activate) {
  if (!bundle_id || !*bundle_id) return false;
  NSArray<NSRunningApplication *> *running = [NSRunningApplication runningApplicationsWithBundleIdentifier:@(bundle_id)];
  pid_t front = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  for (NSRunningApplication *app in running) if (app.processIdentifier == front) return true;
  NSRunningApplication *app = running.firstObject;
  if (activate && app && !app.terminated) [app activateWithOptions:0];
  return false;
}

// ---------- putting the words in, as OpenWhispr does (resources/macos-fast-paste.swift, src/helpers/clipboard.js) ----------
// Pasted: the clipboard kept, the words put on it for this Mac only and marked transient (clipboard managers
// leave them out) and as ours, ⌘V pressed by the key that makes "v" with ⌘ on the current layout, and the
// clipboard given back once the app has read the words, unless something else was copied meanwhile. Typed
// instead where pasting is unreliable (tt_types_instead): in pieces of whole characters, 20 units at most,
// posted to that app alone, so switching apps can't send them on.

/// Marks the words we put on the clipboard, so a paste that follows one still waiting to give the clipboard
/// back never takes our words for the person's.
static NSPasteboardType const TTInsertMark = @"com.tabtasker.dictate.paste";

/// The words, handed over when the app reads them: the read is the receipt that the paste went in.
@interface TTInsertWords : NSObject <NSPasteboardItemDataProvider>
@property (copy) NSString *text;
@property CFAbsoluteTime readAt;
@end
@implementation TTInsertWords
- (void)pasteboard:(NSPasteboard *)pasteboard item:(NSPasteboardItem *)item provideDataForType:(NSPasteboardType)type {
  (void)pasteboard;
  [item setString:self.text forType:type];
  if (!self.readAt) self.readAt = CFAbsoluteTimeGetCurrent();
}
@end

static void TTInsertPost(CGEventRef event, pid_t pid) {
  CGEventSetIntegerValueField(event, kCGEventSourceUserData, TT_VOICE_MARK);
  if (pid > 0) CGEventPostToPid(pid, event); else CGEventPost(kCGAnnotatedSessionEventTap, event);
  CFRelease(event);
}
static const CGKeyCode TTInsertNoKey = UINT16_MAX;
/// The key that types `wanted` with ⌘ held on the current layout, so ⌘V is V on Dvorak, AZERTY or "Dvorak -
/// QWERTY ⌘" too; the last ASCII-capable layout when an input method has none of its own. TTInsertNoKey when
/// neither has it: the US key's code could run another shortcut there.
static CGKeyCode TTInsertKeyFor(UniChar wanted) {
  TISInputSourceRef source = TISCopyCurrentKeyboardLayoutInputSource();
  CFDataRef layout = source ? TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) : NULL;
  if (!layout) {
    if (source) CFRelease(source);
    source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
    layout = source ? TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) : NULL;
  }
  CGKeyCode found = TTInsertNoKey;
  if (layout) {
    const UCKeyboardLayout *keys = (const UCKeyboardLayout *)CFDataGetBytePtr(layout);
    for (CGKeyCode code = 0; code < 128; code++) {
      UInt32 dead = 0; UniChar out[4]; UniCharCount length = 0;
      if (UCKeyTranslate(keys, code, kUCKeyActionDisplay, (cmdKey >> 8) & 0xFF, LMGetKbdType(), kUCKeyTranslateNoDeadKeysMask, &dead, 4, &length, out) == noErr && length == 1 && out[0] == wanted) { found = code; break; }
    }
  }
  if (source) CFRelease(source);
  return found;
}
static BOOL TTInsertPlainLayout(void) {
  TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
  if (!source) return NO;
  CFStringRef type = TISGetInputSourceProperty(source, kTISPropertyInputSourceType);
  BOOL plain = type && CFEqual(type, kTISTypeKeyboardLayout);
  CFRelease(source);
  return plain;
}
/// What typing would turn into key presses (Return sends a form, runs a cell or a terminal command): line
/// breaks and control characters, but not the joiners inside an emoji.
static NSCharacterSet *TTInsertBreaks(void) {
  static NSCharacterSet *breaks;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSMutableCharacterSet *set = [NSMutableCharacterSet newlineCharacterSet];
    [set addCharactersInRange:NSMakeRange(0, 0x20)]; [set addCharactersInRange:NSMakeRange(0x7F, 0x21)];
    breaks = [set copy];
  });
  return breaks;
}
/// Each character's length in UTF-16 units, characters as the person sees them.
static NSData *TTInsertCharacters(NSString *text) {
  NSMutableData *lengths = [NSMutableData new];
  [text enumerateSubstringsInRange:NSMakeRange(0, text.length) options:NSStringEnumerationByComposedCharacterSequences | NSStringEnumerationSubstringNotRequired usingBlock:^(NSString *part, NSRange range, NSRange whole, BOOL *stop) {
    (void)part; (void)whole; (void)stop;
    size_t units = range.length; [lengths appendBytes:&units length:sizeof units];
  }];
  return lengths;
}
static NSArray<NSDictionary<NSPasteboardType, NSData *> *> *TTInsertKeep(NSPasteboard *board) {
  NSMutableArray *kept = [NSMutableArray new];
  for (NSPasteboardItem *item in board.pasteboardItems) {
    if ([item.types containsObject:TTInsertMark]) continue; // our words, never the person's (and asking for them would count as a read)
    NSMutableDictionary *types = [NSMutableDictionary new];
    for (NSPasteboardType type in item.types) { NSData *data = [item dataForType:type]; if (data) types[type] = data; }
    if (types.count) [kept addObject:types];
  }
  return kept;
}
static void TTInsertGiveBack(NSPasteboard *board, NSArray<NSDictionary<NSPasteboardType, NSData *> *> *kept) {
  [board clearContents];
  NSMutableArray *items = [NSMutableArray new];
  for (NSDictionary<NSPasteboardType, NSData *> *types in kept) {
    NSPasteboardItem *item = [NSPasteboardItem new];
    for (NSPasteboardType type in types) [item setData:types[type] forType:type];
    [items addObject:item];
  }
  if (items.count) [board writeObjects:items];
}
/// The words as plain text, for the person to paste themselves.
static void TTInsertLeave(NSPasteboard *board, NSString *text) {
  [board clearContents];
  [board setString:text forType:NSPasteboardTypeString];
}

// The clipboard owed back, while a paste's words are still on it: a paste that comes first (Paste Last, an
// answer, the next hold) gives back this, the person's, and takes the debt over. On the main thread, as all of this.
static NSArray *TTInsertOwed;
static NSInteger TTInsertOwedAt; // the clipboard's change count with our words on it
static NSUInteger TTInsertPastes, TTInsertOwing; // pastes so far; the one that gives it back
// The clipboard as a hold began, so the paste at its end needn't read it again unless it changed since.
static NSArray *TTInsertEarly;
static NSInteger TTInsertEarlyAt;

/// On the main thread, as a hold that may paste begins.
void TTInsertPrepare(void) {
  NSPasteboard *board = NSPasteboard.generalPasteboard;
  if (TTInsertOwed && TTInsertOwedAt == board.changeCount) return; // our words: what's owed is the person's
  TTInsertEarly = TTInsertKeep(board);
  TTInsertEarlyAt = board.changeCount;
}
/// The person's clipboard, whatever is on it now.
static NSArray *TTInsertTheirs(NSPasteboard *board) {
  NSInteger now = board.changeCount;
  NSArray *kept = TTInsertOwed && TTInsertOwedAt == now ? TTInsertOwed : TTInsertEarly && TTInsertEarlyAt == now ? TTInsertEarly : TTInsertKeep(board);
  TTInsertEarly = nil;
  return kept;
}

/// Return, to the app `pid` the words went to: a chat app sends them.
void TTInsertReturn(pid_t pid) {
  for (int down = 1; down >= 0; down--) {
    CGEventRef key = CGEventCreateKeyboardEvent(NULL, kVK_Return, down);
    CGEventSetFlags(key, 0); // not the fn or control still held
    TTInsertPost(key, pid);
  }
}

/// Types `text` into the app `pid` as key presses, in pieces of whole characters, 20 units at most, posted to that
/// app alone; no modifier rides along (not the fn, control or command still held). Off the main thread: it waits
/// between pieces.
static void TTInsertKeys(NSString *text, pid_t pid) {
  NSData *lengths = TTInsertCharacters(text);
  size_t characters = lengths.length / sizeof(size_t);
  if (!characters) return;
  NSMutableData *ends = [NSMutableData dataWithLength:characters * sizeof(size_t)];
  size_t chunks = tt_type_chunks(lengths.bytes, characters, ends.mutableBytes);
  const size_t *length = lengths.bytes, *end = ends.bytes;
  for (size_t c = 0, character = 0, unit = 0; c < chunks; c++) {
    size_t from = unit;
    for (; character < end[c]; character++) unit += length[character];
    NSRange piece = NSMakeRange(from, unit - from);
    NSMutableData *units = [NSMutableData dataWithLength:piece.length * sizeof(UniChar)];
    [text getCharacters:units.mutableBytes range:piece];
    for (int down = 1; down >= 0; down--) {
      CGEventRef key = CGEventCreateKeyboardEvent(NULL, 0, down);
      CGEventSetFlags(key, 0);
      CGEventKeyboardSetUnicodeString(key, piece.length, units.bytes);
      TTInsertPost(key, pid);
    }
    usleep(2000);
  }
}

// ---------- live: the field shows what has been heard so far, and is put right as it's heard again ----------
/// Whether `text` holds a line break, which typed would press Return (send a message, run a command).
BOOL TTInsertHasBreak(NSString *text) { return [text rangeOfCharacterFromSet:TTInsertBreaks()].location != NSNotFound; }
static NSArray<NSString *> *TTInsertGraphemes(NSString *text) {
  NSMutableArray<NSString *> *all = [NSMutableArray new];
  [text enumerateSubstringsInRange:NSMakeRange(0, text.length) options:NSStringEnumerationByComposedCharacterSequences usingBlock:^(NSString *one, NSRange a, NSRange b, BOOL *stop) {
    (void)a; (void)b; (void)stop; [all addObject:one];
  }];
  return all;
}
/// From what the field was given last (`from`) to what it gets now (`to`): Delete back over what comes after
/// their common start, a character at a time, then the rest of `to` typed. One queue keeps the edits in order,
/// so one never overtakes the last; `done` runs on the main thread once this one is in.
void TTInsertEdit(NSString *from, NSString *to, pid_t pid, void (^done)(void)) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("com.tabtasker.dictate.live", DISPATCH_QUEUE_SERIAL); });
  NSArray<NSString *> *was = TTInsertGraphemes(from ?: @""), *now = TTInsertGraphemes(to ?: @"");
  NSUInteger same = 0;
  while (same < was.count && same < now.count && [was[same] isEqualToString:now[same]]) same++;
  NSUInteger erase = was.count - same;
  NSString *type = [[now subarrayWithRange:NSMakeRange(same, now.count - same)] componentsJoinedByString:@""];
  dispatch_async(queue, ^{
    for (NSUInteger i = 0; i < erase; i++) {
      for (int down = 1; down >= 0; down--) {
        CGEventRef key = CGEventCreateKeyboardEvent(NULL, kVK_Delete, down);
        CGEventSetFlags(key, 0); // with fn still held it would delete forward
        TTInsertPost(key, pid);
      }
      usleep(1500);
    }
    TTInsertKeys(type, pid);
    if (done) dispatch_async(dispatch_get_main_queue(), done);
  });
}

/// On the main thread. Puts `text` at the cursor of the app `pid` (with `bundle`), and calls `done` on the main
/// thread once it is in, or once it's clear it won't be: TTInsertUnread when the app never read the paste, the
/// words then left on the clipboard for the person to paste, and a notice saying so.
void TTInsertText(NSString *text, pid_t pid, NSString *bundle, void (^done)(TTInserted how)) {
  if (!text.length) { dispatch_async(dispatch_get_main_queue(), ^{ done(TTInsertUnread); }); return; }
  BOOL oneLine = [text rangeOfCharacterFromSet:TTInsertBreaks()].location == NSNotFound;
  NSData *lengths = TTInsertCharacters(text);
  size_t characters = lengths.length / sizeof(size_t);
  if (tt_types_instead(tt_typed_browser(bundle.UTF8String), TTInsertPlainLayout(), characters, text.length, oneLine)) {
    TTInsertEarly = nil; // the clipboard isn't touched
    NSString *words = [text copy];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
      TTInsertKeys(words, pid);
      dispatch_async(dispatch_get_main_queue(), ^{ done(TTInsertTyped); });
    });
    return;
  }
  NSPasteboard *board = NSPasteboard.generalPasteboard;
  CGKeyCode v = TTInsertKeyFor('v');
  if (v == TTInsertNoKey) {
    TTInsertLeave(board, text);
    dictate_ui_notice("Couldn’t find ⌘V on your keyboard layout, so your words are on the clipboard.");
    dispatch_async(dispatch_get_main_queue(), ^{ done(TTInsertUnread); });
    return;
  }
  NSArray *kept = TTInsertTheirs(board);
  NSUInteger paste = ++TTInsertPastes;
  [board prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
  TTInsertWords *words = [TTInsertWords new];
  words.text = text;
  NSPasteboardItem *item = [NSPasteboardItem new];
  [item setDataProvider:words forTypes:@[NSPasteboardTypeString]];
  [item setData:[NSData data] forType:@"org.nspasteboard.TransientType"];
  [item setData:[NSData data] forType:TTInsertMark];
  [board writeObjects:@[item]];
  NSInteger ours = board.changeCount;
  TTInsertOwed = kept; TTInsertOwedAt = ours; TTInsertOwing = paste;
  // A moment for the pasteboard to settle before the app is asked to read it (OpenWhispr waits 15 ms).
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, v, true), up = CGEventCreateKeyboardEvent(NULL, v, false);
    CGEventSetFlags(down, kCGEventFlagMaskCommand); CGEventSetFlags(up, kCGEventFlagMaskCommand);
    TTInsertPost(down, 0);
    usleep(8000);
    TTInsertPost(up, 0);
    CFAbsoluteTime pressed = CFAbsoluteTimeGetCurrent();
    __block BOOL told = NO;
    void (^tell)(TTInserted) = ^(TTInserted how) { if (!told) { told = YES; done(how); } };
    __block void (^wait)(void);
    __block void (^waitRef)(void);
    wait = ^{
      BOOL latest = TTInsertOwing == paste;
      TTPasteStep step = tt_paste_step(CFAbsoluteTimeGetCurrent(), pressed, words.readAt, board.changeCount == ours, latest);
      if (words.readAt) tell(TTInsertPasted); // in: Return can follow while the clipboard waits to go back
      if (step == TTPasteWait) { dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_MSEC), dispatch_get_main_queue(), waitRef); return; }
      if (step == TTPasteRestore) TTInsertGiveBack(board, kept);
      if (step == TTPasteUnread) {
        TTInsertLeave(board, text);
        dictate_ui_notice("The app didn’t take the paste, so your words are on the clipboard.");
      }
      if (latest) TTInsertOwed = nil;
      tell(TTInsertUnread); // not read, if it hasn't been told otherwise
      waitRef = nil;
    };
    waitRef = wait;
    wait();
  });
}
