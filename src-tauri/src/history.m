#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

// History's "Type again": the click lands in Settings, so the app that was in front before it takes
// the front again, and the words are typed there once it has.

void dictate_type_text(const char *text);

// The app owning the frontmost ordinary window that isn't ours. Window owners and layers need no
// Screen Recording permission, only names do.
static NSRunningApplication *TTHistoryAppBelow(void) {
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  pid_t me = NSProcessInfo.processInfo.processIdentifier;
  for (NSDictionary *window in windows) {
    pid_t pid = [window[(id)kCGWindowOwnerPID] intValue];
    CGRect bounds = CGRectZero;
    CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds);
    if (pid == me || [window[(id)kCGWindowLayer] intValue] != 0 || [window[(id)kCGWindowAlpha] doubleValue] <= 0 || bounds.size.width < 40 || bounds.size.height < 40) continue;
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (app.activationPolicy == NSApplicationActivationPolicyRegular && !app.terminated) return app;
  }
  return nil;
}

// On the main thread. 0 when the words are on their way, 1 without Accessibility, 2 with no app to type into.
int dictate_history_type(const char *text) {
  if (!text || !*text) return 2;
  if (!AXIsProcessTrusted()) return 1;
  NSRunningApplication *target = TTHistoryAppBelow();
  if (!target) return 2;
  NSString *words = @(text);
  NSNotificationCenter *center = NSWorkspace.sharedWorkspace.notificationCenter;
  __block id observer = nil;
  __block BOOL done = NO;
  void (^type)(void) = ^{
    if (done) return;
    done = YES;
    if (observer) { [center removeObserver:observer]; observer = nil; }
    // Typing into whatever else came forward would put the words in the wrong place.
    if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == target.processIdentifier) dictate_type_text(words.UTF8String);
  };
  // The app's window takes key a moment after the app turns active.
  void (^settle)(void) = ^{ dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), dispatch_get_main_queue(), type); };
  if (target.active) { settle(); return 0; }
  observer = [center addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
    NSRunningApplication *app = note.userInfo[NSWorkspaceApplicationKey];
    if (app.processIdentifier == target.processIdentifier) settle();
  }];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), type);
  if (@available(macOS 14.0, *)) [NSApp yieldActivationToApplication:target];
  [target activateWithOptions:0];
  return 0;
}
