#import <Foundation/Foundation.h>

// Meetings: the microphone and the Mac's own audio, recorded together.

// `action` is "start" or "stop"; false when nothing changed.
bool dictate_meeting(const char *action) {
  (void)action;
  return false;
}
