#import <AppKit/AppKit.h>

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
