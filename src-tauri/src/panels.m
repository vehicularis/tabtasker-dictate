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
