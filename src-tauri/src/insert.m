#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include "keys.h"

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
// leave them out), ⌘V pressed by the key that makes "v" on the current layout, and the clipboard given back once
// the app has read the words, unless something else was copied meanwhile. Typed instead where pasting is
// unreliable (tt_types_instead): in pieces of 20 posted to that app alone, so switching apps can't send them on.

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
/// The key that types `wanted` on the current layout with no modifier, so ⌘V is V on Dvorak or AZERTY too.
static CGKeyCode TTInsertKeyFor(UniChar wanted) {
  CGKeyCode found = kVK_ANSI_V;
  TISInputSourceRef source = TISCopyCurrentKeyboardLayoutInputSource();
  CFDataRef layout = source ? TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) : NULL;
  if (layout) {
    const UCKeyboardLayout *keys = (const UCKeyboardLayout *)CFDataGetBytePtr(layout);
    for (CGKeyCode code = 0; code < 128; code++) {
      UInt32 dead = 0; UniChar out[4]; UniCharCount length = 0;
      if (UCKeyTranslate(keys, code, kUCKeyActionDown, 0, LMGetKbdType(), kUCKeyTranslateNoDeadKeysMask, &dead, 4, &length, out) == noErr && length == 1 && out[0] == wanted) { found = code; break; }
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
static BOOL TTInsertChromium(NSString *bundle) {
  static NSSet<NSString *> *browsers;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ browsers = [NSSet setWithArray:@[@"com.google.Chrome", @"com.google.Chrome.beta", @"com.google.Chrome.dev", @"com.google.Chrome.canary", @"org.chromium.Chromium",
    @"com.brave.Browser", @"com.microsoft.edgemac", @"company.thebrowser.Browser", @"com.vivaldi.Vivaldi", @"com.operasoftware.Opera"]]; });
  return bundle && [browsers containsObject:bundle];
}
static NSArray<NSDictionary<NSPasteboardType, NSData *> *> *TTInsertKeep(NSPasteboard *board) {
  NSMutableArray *kept = [NSMutableArray new];
  for (NSPasteboardItem *item in board.pasteboardItems) {
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

/// On the main thread. Puts `text` at the cursor of the app `pid` (with `bundle`), and calls `done` on the main
/// thread once it is in: `pasted` false when it was typed, or when the app never read the paste, in which case
/// the words are left on the clipboard for the person to paste.
void TTInsertText(NSString *text, pid_t pid, NSString *bundle, void (^done)(BOOL pasted)) {
  if (!text.length) { dispatch_async(dispatch_get_main_queue(), ^{ done(NO); }); return; }
  BOOL oneLine = [text rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location == NSNotFound;
  if (tt_types_instead(TTInsertChromium(bundle), TTInsertPlainLayout(), text.length, oneLine)) {
    NSString *words = [text copy];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
      for (NSUInteger at = 0; at < words.length;) {
        NSRange piece = [words rangeOfComposedCharacterSequencesForRange:NSMakeRange(at, MIN(20, words.length - at))];
        NSMutableData *units = [NSMutableData dataWithLength:piece.length * sizeof(UniChar)];
        [words getCharacters:units.mutableBytes range:piece];
        for (int down = 1; down >= 0; down--) {
          CGEventRef key = CGEventCreateKeyboardEvent(NULL, 0, down);
          CGEventSetFlags(key, 0);
          CGEventKeyboardSetUnicodeString(key, piece.length, units.bytes);
          TTInsertPost(key, pid);
        }
        usleep(2000);
        at = NSMaxRange(piece);
      }
      dispatch_async(dispatch_get_main_queue(), ^{ done(NO); });
    });
    return;
  }
  NSPasteboard *board = NSPasteboard.generalPasteboard;
  NSArray *kept = TTInsertKeep(board);
  [board prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
  TTInsertWords *words = [TTInsertWords new];
  words.text = text;
  NSPasteboardItem *item = [NSPasteboardItem new];
  [item setDataProvider:words forTypes:@[NSPasteboardTypeString]];
  [item setData:[NSData data] forType:@"org.nspasteboard.TransientType"];
  [board writeObjects:@[item]];
  NSInteger ours = board.changeCount;
  CGKeyCode v = TTInsertKeyFor('v');
  // A moment for the pasteboard to settle before the app is asked to read it.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, v, true), up = CGEventCreateKeyboardEvent(NULL, v, false);
    CGEventSetFlags(down, kCGEventFlagMaskCommand); CGEventSetFlags(up, kCGEventFlagMaskCommand);
    TTInsertPost(down, 0);
    usleep(8000);
    TTInsertPost(up, 0);
    CFAbsoluteTime pressed = CFAbsoluteTimeGetCurrent();
    __block void (^wait)(void);
    __block void (^waitRef)(void);
    wait = ^{
      CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
      if (words.readAt && now >= tt_restore_at(pressed, words.readAt)) {
        if (board.changeCount == ours) TTInsertGiveBack(board, kept); // unless something else was copied since
        waitRef = nil; done(YES); return;
      }
      if (!words.readAt && now - pressed > 3) {
        // Nothing read it: the words stay, as plain text, for the person to paste.
        if (board.changeCount == ours) { [board clearContents]; [board setString:text forType:NSPasteboardTypeString]; }
        waitRef = nil; done(NO); return;
      }
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_MSEC), dispatch_get_main_queue(), waitRef);
    };
    waitRef = wait;
    wait();
  });
}
