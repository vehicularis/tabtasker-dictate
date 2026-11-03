#import <AppKit/AppKit.h>

// The Mac's own pickers for the Settings pages.

typedef void (*TTVoiceFolderChosen)(void *context, const char *path);

// On the main thread: a folder picker, as a sheet on `window` when it is on screen, opening at `start`.
// Calls `done` once, with the chosen folder or NULL when the person cancels.
void dictate_choose_folder(void *window, const char *message, const char *start, void *context, TTVoiceFolderChosen done) {
  NSOpenPanel *panel = NSOpenPanel.openPanel;
  panel.canChooseDirectories = YES;
  panel.canChooseFiles = NO;
  panel.allowsMultipleSelection = NO;
  panel.canCreateDirectories = YES;
  panel.prompt = @"Choose";
  if (message && *message) panel.message = @(message);
  if (start && *start) panel.directoryURL = [NSURL fileURLWithPath:@(start) isDirectory:YES];
  void (^finish)(NSModalResponse) = ^(NSModalResponse response) {
    NSURL *chosen = response == NSModalResponseOK ? panel.URLs.firstObject : nil;
    done(context, chosen ? chosen.path.fileSystemRepresentation : NULL);
  };
  NSWindow *parent = (__bridge NSWindow *)window;
  if (parent.isVisible) [panel beginSheetModalForWindow:parent completionHandler:finish];
  else finish([panel runModal]);
}

// The window's title bar, as TabTasker Business's: an empty compact toolbar, so AppKit itself makes the bar
// 40 points tall and centres the traffic lights in it (without one they sit 4 points above the tabs). Nothing
// moves the buttons after AppKit, so they cannot jump on a resize. Hidden in full screen, where AppKit would
// otherwise show an empty band over the page. At creation and on every resize, which also comes with full screen.
void dictate_window_toolbar(void *window) {
  NSWindow *native = (__bridge NSWindow *)window;
  if (!NSThread.isMainThread) { dispatch_async(dispatch_get_main_queue(), ^{ dictate_window_toolbar((__bridge void *)native); }); return; }
  if (!native.toolbar) {
    native.toolbarStyle = NSWindowToolbarStyleUnifiedCompact; // the style first: under the default one the toolbar is 66 points for a moment
    native.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
    native.toolbar = [[NSToolbar alloc] init];
  }
  BOOL visible = !(native.styleMask & NSWindowStyleMaskFullScreen);
  if (native.toolbar.visible != visible) native.toolbar.visible = visible;
}
