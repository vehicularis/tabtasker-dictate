#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

// Learning from corrections. Once a dictation is typed, the field it went into is read again for 30 s;
// a dictated word the person then types over becomes a suggestion for the vocabulary. text.rs decides
// what counts as a correction, and nothing is added without a yes.
extern int dictate_correction(const char *before, const char *after, size_t start, size_t length, char *word, size_t capacity);
extern void dictate_learned(const char *word);
extern bool dictate_learn_typing(const char *before, const char *after, size_t caret);

// A longer field (a terminal's scrollback, a whole document) costs too much to read twice a second.
static const NSUInteger TTVoiceLearnLongest = 50000;
static const NSTimeInterval TTVoiceLearnFor = 30, TTVoiceLearnArrive = 3, TTVoiceLearnSettle = 1.5;
// The reads run on the main thread beside the key monitors: an app that stops answering costs at most
// this per read, and the first read it fails ends the watch, instead of the system's 6 s each.
static const float TTVoiceLearnPatience = 0.2;

static NSString *TTVoiceLearnValue(id field) {
  if (!field) return nil;
  AXUIElementRef element = (__bridge AXUIElementRef)field;
  CFTypeRef count = NULL;
  AXError error = AXUIElementCopyAttributeValue(element, kAXNumberOfCharactersAttribute, &count);
  if (error == kAXErrorCannotComplete) return nil;
  if (error == kAXErrorSuccess) {
    NSNumber *length = (__bridge_transfer NSNumber *)count;
    if ([length isKindOfClass:NSNumber.class] && length.unsignedIntegerValue > TTVoiceLearnLongest) return nil;
  }
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXValueAttribute, &value) != kAXErrorSuccess) return nil;
  id text = (__bridge_transfer id)value;
  return [text isKindOfClass:NSString.class] && [text length] <= TTVoiceLearnLongest ? text : nil;
}

// A field that hides what is typed is never read.
static BOOL TTVoiceLearnSecure(id field) {
  CFTypeRef subrole = NULL;
  if (AXUIElementCopyAttributeValue((__bridge AXUIElementRef)field, kAXSubroleAttribute, &subrole) != kAXErrorSuccess) return NO;
  NSString *name = (__bridge_transfer NSString *)subrole;
  return [name isKindOfClass:NSString.class] && [name isEqualToString:(__bridge NSString *)kAXSecureTextFieldSubrole];
}

static NSUInteger TTVoiceLearnCaret(id field, NSUInteger fallback) {
  CFTypeRef selected = NULL;
  if (AXUIElementCopyAttributeValue((__bridge AXUIElementRef)field, kAXSelectedTextRangeAttribute, &selected) != kAXErrorSuccess) return fallback;
  CFRange range = { 0, 0 };
  BOOL read = CFGetTypeID(selected) == AXValueGetTypeID() && AXValueGetValue((AXValueRef)selected, kAXValueTypeCFRange, &range);
  CFRelease(selected);
  return read && range.location >= 0 ? (NSUInteger)range.location : fallback;
}

// A word the person typed in place of a dictated one is a name or a term when the Mac's dictionary
// doesn't know it; a known word ("their" for "there") is just a slip.
static BOOL TTVoiceLearnUnknown(NSString *word) {
  return [NSSpellChecker.sharedSpellChecker checkSpellingOfString:word startingAt:0].location != NSNotFound;
}

@interface TTVoiceLearn : NSObject
// `pending` is a settled edit whose caret is still in its word: it counts once the field changes some
// other way (sent, cleared) or the watch ends, and not if the word is typed on.
@property (copy) NSString *text, *before, *latest, *pending;
@property (strong) id field;
@property NSRange dictated;
@property NSTimeInterval since, changed;
@property (strong) NSTimer *timer;
@end

@implementation TTVoiceLearn
- (void)every:(NSTimeInterval)interval run:(void (^)(TTVoiceLearn *learn))step {
  [self.timer invalidate];
  __weak TTVoiceLearn *weak = self;
  self.timer = [NSTimer timerWithTimeInterval:interval repeats:YES block:^(NSTimer *timer) { (void)timer; TTVoiceLearn *learn = weak; if (learn) step(learn); }];
  [NSRunLoop.mainRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];
}
- (void)watch:(NSString *)text {
  self.text = text; self.field = nil; self.since = NSProcessInfo.processInfo.systemUptime;
  [self every:0.25 run:^(TTVoiceLearn *learn) { [learn find]; }];
}
- (void)stop { [self.timer invalidate]; self.timer = nil; self.field = nil; self.before = self.latest = self.pending = nil; }
// The watch ends early (a new hold, the field gone): an edit waiting on its caret is as done as it gets.
- (void)finish {
  if (self.pending) [self check:self.pending];
  [self stop];
}
// Our keystrokes land in the field a moment after they are sent: the dictated words are the ones
// that end at the caret. The front app's element is asked rather than the system-wide one, whose
// timeout would apply to every element in this process.
- (void)find {
  NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
  if (now - self.since > TTVoiceLearnArrive) { [self stop]; return; }
  pid_t pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  if (pid <= 0 || pid == NSProcessInfo.processInfo.processIdentifier) return;
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(app, TTVoiceLearnPatience);
  CFTypeRef focused = NULL;
  AXError error = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focused);
  CFRelease(app);
  if (error == kAXErrorCannotComplete) { [self stop]; return; }
  id field = (__bridge_transfer id)focused;
  if (!field) return;
  AXUIElementSetMessagingTimeout((__bridge AXUIElementRef)field, TTVoiceLearnPatience);
  if (TTVoiceLearnSecure(field)) return;
  NSString *value = TTVoiceLearnValue(field);
  if (!value) return;
  NSUInteger end = MIN(TTVoiceLearnCaret(field, value.length), value.length);
  NSRange found = [value rangeOfString:self.text options:NSBackwardsSearch range:NSMakeRange(0, end)];
  if (found.location == NSNotFound || NSMaxRange(found) != end) return;
  self.field = field; self.before = self.latest = value; self.dictated = found;
  self.since = self.changed = now;
  [self every:0.5 run:^(TTVoiceLearn *learn) { [learn poll]; }];
}
- (BOOL)corrects:(NSString *)value {
  char word[256];
  return dictate_correction(self.before.UTF8String, value.UTF8String, self.dictated.location, self.dictated.length, word, sizeof word) != 0;
}
- (void)poll {
  NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
  NSString *value = TTVoiceLearnValue(self.field);
  if (!value) { [self finish]; return; } // the field is gone, too long now, or its app stopped answering
  if (![value isEqualToString:self.latest]) {
    // Typing on in the word makes a waiting edit stale; any other change means it was finished.
    if (self.pending && ![self corrects:value]) [self check:self.pending];
    self.pending = nil;
    self.latest = value; self.changed = now;
  }
  BOOL over = now - self.since >= TTVoiceLearnFor;
  // An edit counts once the person stops typing for a moment with the caret out of its word, or when
  // the time is up.
  if ((now - self.changed >= TTVoiceLearnSettle || over) && ![self.latest isEqualToString:self.before]) {
    NSUInteger caret = TTVoiceLearnCaret(self.field, NSNotFound);
    if (!over && caret != NSNotFound && dictate_learn_typing(self.before.UTF8String, self.latest.UTF8String, caret)) self.pending = self.latest;
    else [self check:self.latest];
  }
  if (over) [self stop];
}
- (void)check:(NSString *)value {
  char word[256];
  int found = dictate_correction(self.before.UTF8String, value.UTF8String, self.dictated.location, self.dictated.length, word, sizeof word);
  NSString *learned = found ? [NSString stringWithUTF8String:word] : nil;
  if (learned && (found == 2 || TTVoiceLearnUnknown(learned))) dictate_learned(word);
  self.pending = nil;
  // Later edits are read against the field as it is now, with the dictated words where they moved.
  NSString *before = self.before, *after = value;
  NSUInteger prefix = 0, suffix = 0, shorter = MIN(before.length, after.length);
  while (prefix < shorter && [before characterAtIndex:prefix] == [after characterAtIndex:prefix]) prefix++;
  while (suffix < shorter - prefix && [before characterAtIndex:before.length - 1 - suffix] == [after characterAtIndex:after.length - 1 - suffix]) suffix++;
  NSInteger delta = (NSInteger)after.length - (NSInteger)before.length;
  NSRange dictated = self.dictated;
  if (before.length - suffix <= dictated.location) dictated.location = (NSUInteger)MAX(0, (NSInteger)dictated.location + delta);
  else if (prefix < NSMaxRange(dictated)) dictated.length = (NSUInteger)MAX(0, (NSInteger)dictated.length + delta);
  dictated.length = MIN(dictated.length, after.length - MIN(dictated.location, after.length));
  self.dictated = dictated;
  self.before = after;
}
@end

static TTVoiceLearn *learner;

// On the main thread, as dictated words are typed.
void dictate_learn_watch(const char *text) {
  NSString *words = text ? [NSString stringWithUTF8String:text] : nil;
  if (!words.length || !AXIsProcessTrusted()) return;
  if (!learner) learner = [TTVoiceLearn new];
  [learner watch:words];
}

// On the main thread, as a new hold begins: our own typing is not a correction.
void dictate_learn_stop(void) { [learner finish]; }
