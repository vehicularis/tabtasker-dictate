#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ServiceManagement/ServiceManagement.h>
#import <Carbon/Carbon.h>
#include <dlfcn.h>
#include "keys.h"

// Everything the person sees is drawn by the overlay page (the `overlay` window); this file owns the
// dictate key, the microphone and the overlay window's native parts (blur, click-through).
extern void dictate_ui_state(const char *phase, double level, bool dictating);
extern void dictate_ui_error(const char *message);
extern void dictate_ui_fn(bool down);
extern void dictate_ui_open(const char *what);
extern void dictate_ui_note(const char *text);
extern void dictate_ui_pointer(bool over, double x, double y);
extern void dictate_ui_dock(bool shown, double strip, const char *edge);
extern void dictate_ui_said(const char *text, bool dictated, bool live);
extern void dictate_ui_notice(const char *message);
extern void dictate_log(const char *line);

extern void dictate_cancel(const char *request);
extern void dictate_prepare_models(void);
extern void dictate_disable_models(void);
extern bool dictate_audio(const char *request, const float *samples, size_t count);
extern bool dictate_draft(const char *request, const float *samples, size_t count);
extern bool dictate_note_step(const char *request, size_t base, const float *samples, size_t count);
extern bool dictate_note_finish(const char *request, size_t base, const float *samples, size_t count);
extern void dictate_hold_begin(const char *request, const char *mode, const char *bundle_id);
// A spoken command for Claude (Rust): false when Claude is not connected.
extern bool dictate_command(const char *request, const char *instruction, const char *selection, const char *bundle_id);
extern void dictate_ui_hands_free(bool locked);
extern void dictate_paste_last(void);
extern bool dictate_meeting(const char *action);
extern void dictate_meeting_unstarted(void);
extern void dictate_ui_sticky_hover(const char *id, bool up);

// macOS re-checks which window is under the pointer only when the mouse moves, so a window that just started
// or stopped taking the mouse would still get, or miss, a trackpad scroll that starts with the pointer at rest.
// A move to where the pointer already is makes it look again. (Posting needs Accessibility, which fn has.)
static void TTLookAgain(void) {
  if (!AXIsProcessTrusted()) return;
  CGEventRef here = CGEventCreate(NULL);
  CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGEventGetLocation(here), kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, move);
  CFRelease(move); CFRelease(here);
}
bool dictate_open_at_login(int set);
static NSWindow *TTVoiceOverlayWindow(void);
static void TTVoiceCatchEscape(BOOL on); // Escape as a hot key, defined with the C API below
static void TTGlobeSync(BOOL want, BOOL launch), TTGlobeGiveBack(void); // the globe key's own action, likewise

// ---------- The dictate key and the microphone ----------

@interface TTVoiceAudio : NSObject
@property (strong) AVAudioConverter *converter;
@property (strong) AVAudioFormat *mono;
@property (strong) NSMutableData *samples;
@property BOOL frozen, failed;
@property NSUInteger limit, dropped; // samples it may hold; samples a note has let go of from the front
@property NSUInteger buffers; // what arrived, for the per-hold line in the app log
@property double peak;
@property (strong) AVAudioFormat *heard;
@property double rms;
@property NSTimeInterval meteredAt;
// When the first sound arrived (the microphone is live; 0 until then) and the last that was louder than
// silence, on the uptime clock. `onLive` runs on the main thread once, as the first arrives.
@property NSTimeInterval liveAt, loudAt;
@property (copy) dispatch_block_t onLive;
- (double)level;
- (double)quietFor;
- (void)resetLevel;
- (NSUInteger)count;
- (void)append:(AVAudioPCMBuffer *)buffer;
- (NSData *)freeze;
- (void)lend:(void (^)(NSUInteger base, const float *samples, NSUInteger count))use;
- (void)dropTo:(NSUInteger)transcribed;
- (NSString *)channelLevels;
@end
@implementation TTVoiceAudio {
  double _channelEnergy[8]; // per input channel, for the per-hold log line
  double _channelFrames;
}
- (instancetype)init {
  if ((self = [super init])) {
    self.mono = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:16000 channels:1];
    self.samples = [NSMutableData new];
    self.limit = tt_hold_limit(false);
  }
  return self;
}
// A video call's echo cancellation opens the MacBook's three-microphone array, so the input
// arrives as three channels with no channel layout, which AVAudioConverter mixes down to silence.
// Mixed to mono here instead, at the input's own rate.
- (AVAudioPCMBuffer *)monoFrom:(AVAudioPCMBuffer *)buffer {
  AVAudioChannelCount channels = buffer.format.channelCount;
  if (channels <= 1 || !buffer.floatChannelData) return buffer;
  AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:buffer.format.sampleRate channels:1 interleaved:NO];
  AVAudioPCMBuffer *mono = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:buffer.frameLength];
  mono.frameLength = buffer.frameLength;
  float *out = mono.floatChannelData[0];
  memset(out, 0, sizeof(float) * buffer.frameLength);
  NSUInteger stride = buffer.stride;
  for (AVAudioChannelCount c = 0; c < channels; c++) {
    const float *in = buffer.format.isInterleaved ? buffer.floatChannelData[0] + c : buffer.floatChannelData[c];
    double energy = 0;
    for (AVAudioFrameCount i = 0; i < buffer.frameLength; i++) { float v = in[i * stride]; out[i] += v / channels; energy += v * v; }
    if (c < 8) _channelEnergy[c] += energy;
  }
  _channelFrames += buffer.frameLength;
  return mono;
}
- (NSString *)channelLevels {
  @synchronized (self) {
    if (!_channelFrames) return @"";
    NSMutableArray<NSString *> *levels = [NSMutableArray new];
    for (NSUInteger c = 0; c < MIN(8u, self.heard.channelCount); c++) [levels addObject:[NSString stringWithFormat:@"%.4f", sqrt(_channelEnergy[c] / _channelFrames)]];
    return [NSString stringWithFormat:@", channels %@", [levels componentsJoinedByString:@"/"]];
  }
}
- (void)append:(AVAudioPCMBuffer *)buffer {
  @synchronized (self) {
    if (self.frozen || self.failed) return;
    self.buffers++; self.heard = buffer.format;
    if (!self.liveAt && buffer.frameLength) {
      self.liveAt = NSProcessInfo.processInfo.systemUptime;
      if (self.onLive) dispatch_async(dispatch_get_main_queue(), self.onLive);
    }
    buffer = [self monoFrom:buffer];
    // The input's format can change under a hold (a Bluetooth headset switches profile when its
    // microphone opens), so convert from whatever format this buffer is in.
    if (![buffer.format isEqual:self.converter.inputFormat]) {
      AVAudioConverter *converter = [[AVAudioConverter alloc] initFromFormat:buffer.format toFormat:self.mono];
      if (!converter) { self.failed = YES; return; }
      converter.downmix = YES;
      self.converter = converter;
    }
    AVAudioFrameCount capacity = (AVAudioFrameCount)ceil(buffer.frameLength * 16000.0 / buffer.format.sampleRate) + 32;
    AVAudioPCMBuffer *output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:self.converter.outputFormat frameCapacity:capacity];
    __block BOOL supplied = NO;
    NSError *error;
    AVAudioConverterOutputStatus status = [self.converter convertToBuffer:output error:&error withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount count, AVAudioConverterInputStatus *inputStatus) {
      (void)count;
      *inputStatus = supplied ? AVAudioConverterInputStatus_NoDataNow : AVAudioConverterInputStatus_HaveData;
      if (supplied) return nil;
      supplied = YES; return buffer;
    }];
    NSUInteger bytes = output.frameLength * sizeof(float);
    if (status == AVAudioConverterOutputStatus_Error || error || self.samples.length + bytes > self.limit * sizeof(float)) { self.failed = YES; return; }
    if (bytes) {
      const float *samples = output.floatChannelData[0];
      double sum = 0;
      for (AVAudioFrameCount i = 0; i < output.frameLength; i++) sum += samples[i] * samples[i];
      self.rms = sqrt(sum / output.frameLength);
      self.peak = MAX(self.peak, self.rms);
      self.meteredAt = NSProcessInfo.processInfo.systemUptime;
      if (self.rms > TT_SPEAKING) self.loudAt = self.meteredAt;
      [self.samples appendBytes:samples length:bytes];
    }
  }
}
- (double)level {
  @synchronized (self) {
    double age = MAX(0, NSProcessInfo.processInfo.systemUptime - self.meteredAt - 0.12);
    return self.frozen ? 0 : self.rms * exp(-age * 12);
  }
}
- (void)resetLevel { @synchronized (self) { self.rms = 0; } }
// How long what arrived has been below speech: since the last louder buffer, or the first if none was. 0 until one arrives.
- (double)quietFor {
  @synchronized (self) {
    double since = MAX(self.loudAt, self.liveAt);
    return since ? NSProcessInfo.processInfo.systemUptime - since : 0;
  }
}
- (NSUInteger)count { @synchronized (self) { return self.samples.length / sizeof(float); } }
// What it holds, from `base` samples in, without a copy: ten minutes are 38 MB, and speech copies only
// what it has not heard yet. Nothing changes the buffer until `use` returns.
- (void)lend:(void (^)(NSUInteger base, const float *samples, NSUInteger count))use {
  @synchronized (self) { use(self.dropped, self.samples.bytes, self.samples.length / sizeof(float)); }
}
// A note's audio up to `transcribed` samples into it is in its words: let it go.
- (void)dropTo:(NSUInteger)transcribed {
  @synchronized (self) {
    NSUInteger drop = MIN(transcribed > self.dropped ? transcribed - self.dropped : 0, self.samples.length / sizeof(float));
    [self.samples replaceBytesInRange:NSMakeRange(0, drop * sizeof(float)) withBytes:NULL length:0];
    self.dropped += drop;
  }
}
- (NSData *)freeze { @synchronized (self) { self.frozen = YES; self.rms = 0; return [self.samples copy]; } }
@end

typedef NS_ENUM(NSUInteger, TTVoicePhase) { TTVoiceIdle, TTVoiceListening, TTVoiceFinishing, TTVoiceSubmitting };

@interface TTVoiceCommands : NSObject
@property BOOL enabled, held, pressed, blocked, modelReady, modelPreparing, trusted, dictating; // pressed: the dictate key, physically
@property NSUInteger generation, gesture;
@property (nonatomic) TTVoicePhase phase;
@property (copy) NSString *request, *modelMessage;
@property (strong) AVAudioEngine *engine;
@property (strong) TTVoiceAudio *audio;
@property (strong) id localMonitor, globalMonitor;
@property (strong) NSTimer *levelTimer, *trustTimer, *draftTimer;
@property double displayLevel;
@property NSTimeInterval listeningSince;
@property NSUInteger inputChanges;
@property NSUInteger chimed; // the generation the start sound played for
// The microphone: since when it has run (0 while it starts again after a change), whether this hold has
// opened it once more for sending nothing, and whether it gave up a chosen input for the Mac's own then.
@property NSTimeInterval runningSince;
@property BOOL restarted, onDefault;
@property (copy) NSString *typed; // dictation: what this hold put at the cursor
@property BOOL typingStopped; // the person clicked or typed after our words went in
// Everything dictation typed into one field over consecutive holds, while the person has not clicked
// or typed there since: a hold that continues it starts with a space.
@property (copy) NSString *dictated, *lead; // lead: the space a hold that continues it types first
@property pid_t dictatedApp;
@property (strong) id dictatedField;
// A note from the overlay's note button: no minute cap, transcribed while it is said, done after three
// minutes of quiet.
@property BOOL noting;
@property NSTimeInterval lastSpoke;
// The app's settings as Rust last applied them (settings.json, camelCase), and what this file reads
// from them: the dictate key, the modifier that talks to Claude (0 when off or not connected), the
// chords by name as [key code, modifiers], live typing and the sounds.
@property (copy) NSDictionary *settings;
@property TTKey key;
@property NSEventModifierFlags commandFlag;
@property (copy) NSDictionary<NSString *, NSArray<NSNumber *> *> *chords;
@property BOOL handsFree, sounds;
@property BOOL sendAfter; // Return once this hold's words are typed (a chat app, or a spoken "send")
@property double soundVolume; // 0 to 1
@property (copy) NSString *startSound, *stopSound; // names in /System/Library/Sounds
// A hold that speaks to Claude, and a session a double tap keeps listening without the key.
@property BOOL commanding, locked;
@property (strong) NSRunningApplication *app; // in front as the hold began: where its words go
@property (copy) NSString *selection; // a command's selected text, as the hold began
@end

// The text field that has the keyboard focus, as Accessibility sees it.
static id TTVoiceFocusedField(void) {
  AXUIElementRef everything = AXUIElementCreateSystemWide();
  CFTypeRef field = NULL;
  AXUIElementCopyAttributeValue(everything, kAXFocusedUIElementAttribute, &field);
  CFRelease(everything);
  return (__bridge_transfer id)field;
}
static NSString *TTVoiceSelectedText(id field) {
  CFTypeRef selected = NULL;
  if (!field || AXUIElementCopyAttributeValue((__bridge AXUIElementRef)field, kAXSelectedTextAttribute, &selected) != kAXErrorSuccess) return nil;
  id value = (__bridge_transfer id)selected;
  return [value isKindOfClass:NSString.class] ? value : nil;
}
// In this app's own windows words go only into a text field: a typed space would press a focused
// button or flip a switch.
static BOOL TTVoiceTextField(id field) {
  CFTypeRef role = NULL;
  if (!field || AXUIElementCopyAttributeValue((__bridge AXUIElementRef)field, kAXRoleAttribute, &role) != kAXErrorSuccess) return NO;
  id name = (__bridge_transfer id)role;
  return [@[(__bridge NSString *)kAXTextFieldRole, (__bridge NSString *)kAXTextAreaRole, (__bridge NSString *)kAXComboBoxRole] containsObject:name];
}
static BOOL TTVoiceSameField(id one, id other) {
  return one == other || (one && other && CFEqual((__bridge CFTypeRef)one, (__bridge CFTypeRef)other));
}
// Marks our own keystrokes, so the fn monitor never takes them for an fn shortcut.
static const int64_t TTVoiceMark = TT_VOICE_MARK;
// insert.m: the words put in at the cursor, pasted or typed, as OpenWhispr puts them in; the clipboard read as
// a hold begins, so the paste needn't; and Return after them.
void TTInsertText(NSString *text, pid_t pid, NSString *bundle, void (^done)(TTInserted how));
void TTInsertPrepare(void);
void TTInsertReturn(pid_t pid);
// Appearance › Stay clear of the Dock: the overlay window covers the screen's visible area (above the Dock,
// below the menu bar), else the whole screen, so the dots can sit behind an auto-hidden Dock's edge.
static BOOL TTOverlayAvoidsDock = YES;
static void TTOverlayFit(void); // the overlay window, defined with it below
static NSString *TTVoiceDeviceString(AudioObjectID device, AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress address = { selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  CFStringRef value = NULL; UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &value) != noErr || !value) return nil;
  return (__bridge_transfer NSString *)value;
}
// Every device with an input stream, by its UID (stable across reconnects) and name.
static NSArray<NSDictionary *> *TTVoiceInputs(void) {
  AudioObjectPropertyAddress address = { kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr) return @[];
  NSMutableData *ids = [NSMutableData dataWithLength:size];
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, ids.mutableBytes) != noErr) return @[];
  NSMutableArray *inputs = [NSMutableArray array];
  const AudioObjectID *devices = ids.bytes;
  for (UInt32 i = 0; i < size / sizeof(AudioObjectID); i++) {
    AudioObjectPropertyAddress streams = { kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput, kAudioObjectPropertyElementMain };
    UInt32 bytes = 0;
    if (AudioObjectGetPropertyDataSize(devices[i], &streams, 0, NULL, &bytes) != noErr || !bytes) continue;
    NSString *uid = TTVoiceDeviceString(devices[i], kAudioDevicePropertyDeviceUID), *name = TTVoiceDeviceString(devices[i], kAudioObjectPropertyName);
    if (uid && name) [inputs addObject:@{@"id": uid, @"name": name}];
  }
  return inputs;
}
static NSString *TTVoiceChosenInput(void) { return [NSUserDefaults.standardUserDefaults stringForKey:@"DictateInput"]; }
// The Mac's own input (System Settings › Sound).
static AudioObjectID TTVoiceDefaultInput(void) {
  AudioObjectID device = kAudioObjectUnknown; UInt32 size = sizeof(device);
  AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device);
  return device;
}
// The microphone voice records from: the one picked in the dots' menu while it is connected, otherwise
// the Mac's own input.
static AudioObjectID TTVoiceInput(void) {
  AudioObjectID device = kAudioObjectUnknown; UInt32 size = sizeof(device);
  CFStringRef chosen = (__bridge CFStringRef)TTVoiceChosenInput();
  AudioObjectPropertyAddress address = { kAudioHardwarePropertyTranslateUIDToDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  if (chosen && AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, sizeof(chosen), &chosen, &size, &device) == noErr && device != kAudioObjectUnknown) return device;
  return TTVoiceDefaultInput();
}
static NSString *TTVoiceInputName(void) { return TTVoiceDeviceString(TTVoiceInput(), kAudioObjectPropertyName) ?: @"?"; }
// The input volume macOS gives a device (Sound › Input), for the log: its main control, or its first
// channel's when it has only those; -1 when it has neither.
static Float32 TTVoiceInputVolume(AudioObjectID device) {
  for (AudioObjectPropertyElement element = kAudioObjectPropertyElementMain; element <= 1; element++) {
    AudioObjectPropertyAddress address = { kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeInput, element };
    Float32 volume = 0; UInt32 size = sizeof(volume);
    if (AudioObjectHasProperty(device, &address) && AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &volume) == noErr) return volume;
  }
  return -1;
}

static dispatch_queue_t TTVoiceAudioQueue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("com.tabtasker.voice.audio", DISPATCH_QUEUE_SERIAL); });
  return queue;
}

static NSDictionary *TTVoiceObject(id value) { return [value isKindOfClass:NSDictionary.class] ? value : nil; }

// The app each command was said in, by request, so its answer is typed there. The newest few are kept.
static NSMutableArray<NSArray *> *TTVoiceCommandApps(void) {
  static NSMutableArray *apps;
  if (!apps) apps = [NSMutableArray new];
  return apps;
}
static void TTVoiceRememberCommand(NSString *request, NSRunningApplication *app) {
  if (!request || !app) return;
  [TTVoiceCommandApps() addObject:@[request, app]];
  if (TTVoiceCommandApps().count > 8) [TTVoiceCommandApps() removeObjectAtIndex:0];
}
static NSRunningApplication *TTVoiceCommandApp(NSString *request) {
  for (NSArray *pair in TTVoiceCommandApps()) if ([pair[0] isEqualToString:request]) return pair[1];
  return nil;
}
static BOOL TTVoiceFront(NSRunningApplication *app) {
  return app && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == app.processIdentifier;
}
static void TTVoiceWhenFront(NSRunningApplication *app, NSUInteger tries, void (^then)(BOOL front)) {
  if (TTVoiceFront(app) || !tries || !app || app.terminated) { then(TTVoiceFront(app)); return; }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ TTVoiceWhenFront(app, tries - 1, then); });
}
// Brings `app` forward and runs `then` once it is in front, or with NO after about a second.
static void TTVoiceBringForward(NSRunningApplication *app, void (^then)(BOOL front)) {
  if (app && !app.terminated && !TTVoiceFront(app)) [app activateWithOptions:0];
  TTVoiceWhenFront(app, 20, then);
}
// Words that can't be typed where they belong, on the clipboard for the person to paste.
static void TTVoiceCopy(NSString *text) {
  [NSPasteboard.generalPasteboard clearContents];
  [NSPasteboard.generalPasteboard setString:text forType:NSPasteboardTypeString];
}

@implementation TTVoiceCommands {
  TTTaps _taps;
}
@synthesize phase = _phase;
- (instancetype)init {
  if ((self = [super init])) { _key = TTKeyFn; _handsFree = _sounds = YES; _soundVolume = 0.3; _startSound = @"Tink"; _stopSound = @"Pop"; }
  return self;
}
- (const char *)phaseName {
  switch (self.phase) {
    case TTVoiceListening: return "listening";
    case TTVoiceFinishing: return "transcribing";
    case TTVoiceSubmitting: return "sending";
    default: return "idle";
  }
}
- (void)setPhase:(TTVoicePhase)phase {
  _phase = phase;
  TTVoiceCatchEscape(phase == TTVoiceListening || phase == TTVoiceFinishing);
  if (phase != TTVoiceListening && self.locked) { self.locked = NO; dictate_ui_hands_free(false); }
  if (phase == TTVoiceListening && !self.levelTimer) {
    __weak TTVoiceCommands *weak = self;
    self.levelTimer = [NSTimer timerWithTimeInterval:1.0 / 30 repeats:YES block:^(NSTimer *timer) { (void)timer; [weak tick]; }];
    [NSRunLoop.mainRunLoop addTimer:self.levelTimer forMode:NSRunLoopCommonModes];
    // Live passes, again as soon as the last is done (a tick that finds one still running skips): the words
    // the orb writes while you talk, a command's for its card, a hands-free session's pieces. None is typed:
    // the field gets the words once, on release, as OpenWhispr types them. A release frees the engine of a
    // pass that hasn't heard the end (speech.rs finish).
    self.draftTimer = [NSTimer timerWithTimeInterval:0.2 repeats:YES block:^(NSTimer *timer) { (void)timer; [weak draft]; }];
    [NSRunLoop.mainRunLoop addTimer:self.draftTimer forMode:NSRunLoopCommonModes];
  } else if (phase != TTVoiceListening) {
    [self.levelTimer invalidate]; self.levelTimer = nil;
    [self.draftTimer invalidate]; self.draftTimer = nil;
    self.displayLevel = 0;
  }
  dictate_ui_state([self phaseName], self.displayLevel, self.dictating);
}
- (void)draft {
  if (self.phase != TTVoiceListening || !self.request) return;
  const char *request = self.request.UTF8String;
  BOOL noting = self.noting;
  [self.audio lend:^(NSUInteger base, const float *samples, NSUInteger count) {
    if (!count) return;
    if (noting) dictate_note_step(request, base, samples, count);
    else dictate_draft(request, samples, count);
  }];
}
- (void)tick {
  double target = self.audio.level;
  self.displayLevel = target > self.displayLevel ? target : self.displayLevel * 0.82;
  if (self.displayLevel < 0.0001) self.displayLevel = 0;
  dictate_ui_state("listening", MIN(1, self.displayLevel), self.dictating);
  TTVoiceAudio *audio = self.audio;
  NSTimeInterval now = NSProcessInfo.processInfo.systemUptime, running = self.runningSince;
  // A microphone that opened but sends nothing (a headset asleep, an input stuck after a change): open it once more.
  if (audio && running && !self.restarted && tt_capture_stalled(now - running, audio.buffers, audio.peak)) [self restartCapture];
  if (!self.noting) {
    // Half a second short of what the buffer holds, so the end of what was said is sent, not dropped.
    if (!audio || audio.count + 8000 < audio.limit) return;
    dictate_ui_notice(self.locked ? "Stopped at the 10-minute limit." : "Stopped at the 5-minute limit.");
    self.held = NO; [self finish];
    return;
  }
  if (target > TT_SPEAKING) self.lastSpoke = now;
  else if (now - self.lastSpoke > 180) { // a note left running: what was said is kept
    dictate_ui_notice("Stopped the note after 3 minutes of silence.");
    self.held = NO; [self finish];
  }
}
- (void)stopCapture { [self stopCaptureThen:nil]; }
/// `then` runs on the main thread once the engine has stopped on the audio queue, so the last buffer the
/// tap was handed is in the audio by then.
- (void)stopCaptureThen:(dispatch_block_t)then {
  AVAudioEngine *engine = self.engine;
  self.engine = nil;
  if (engine) {
    [NSNotificationCenter.defaultCenter removeObserver:self name:AVAudioEngineConfigurationChangeNotification object:engine];
    dispatch_async(TTVoiceAudioQueue(), ^{
      [engine stop]; @try { [engine.inputNode removeTapOnBus:0]; } @catch (NSException *e) { (void)e; }
      if (then) dispatch_async(dispatch_get_main_queue(), then);
    });
  } else if (then) dispatch_async(dispatch_get_main_queue(), then);
  [self.audio resetLevel]; self.displayLevel = 0;
}
- (void)cancel {
  self.generation++;
  self.gesture++;
  [self stopCapture];
  self.audio = nil;
  if (self.request) dictate_cancel(self.request.UTF8String);
  [self settleTyped];
  self.request = nil; self.dictating = NO; self.noting = NO; self.commanding = NO; self.selection = nil; self.app = nil; self.sendAfter = NO;
  self.phase = TTVoiceIdle;
}
// What this hold typed is in the field now, finished or not; unless the person moved on, the next hold
// carries on from it.
- (void)settleTyped {
  if (self.typed.length) self.dictated = self.typingStopped ? nil : [(self.dictated ?: @"") stringByAppendingString:self.typed];
  [self forgetTyped];
}
- (void)forgetTyped { self.typed = nil; self.typingStopped = NO; self.lead = @""; }
- (void)fail:(NSString *)message {
  [self cancel];
  dictate_ui_error(message.UTF8String);
}
- (void)begin {
  if (self.phase != TTVoiceIdle || !self.enabled || !(self.held || self.locked) || self.blocked) return;
  if (!self.modelReady) { [self fail:@"The speech model is still loading."]; return; }
  self.request = NSUUID.UUID.UUIDString;
  self.generation++;
  [self forgetTyped];
  self.app = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (self.commanding) self.selection = AXIsProcessTrusted() ? TTVoiceSelectedText(TTVoiceFocusedField()) : nil;
  const char *mode = self.noting ? "note" : self.locked ? "handsfree" : self.commanding ? "command" : "dictate";
  dictate_hold_begin(self.request.UTF8String, mode, (self.app.bundleIdentifier ?: @"").UTF8String);
  self.phase = TTVoiceListening;
  self.listeningSince = NSProcessInfo.processInfo.systemUptime;
  if (!self.engine) [self startCapture]; // otherwise the microphone opened when the key went down
  if (self.phase != TTVoiceListening) return;
  // The start sound says the microphone hears you. A Bluetooth headset takes a moment to switch to its
  // microphone, and words said over a sound played before then were lost: micLive plays it as sound arrives.
  if (self.audio.liveAt) [self chimeStart];
  // A hold goes to speech whole, five minutes at most, and a locked session runs to ten, transcribed as it is
  // said: tick sends them as they reach it. A note keeps only what is not yet transcribed.
  self.audio.limit = tt_hold_limit(self.noting || self.locked);
  if (self.noting) self.lastSpoke = self.listeningSince;
  // The clipboard as it is now, so pasting the words at the end needn't read it (unless it changes meanwhile).
  else if (!self.commanding) dispatch_async(dispatch_get_main_queue(), ^{ TTInsertPrepare(); });
}
// A soft cue as listening starts and stops, from the Mac's own sounds, as Dictation › Sounds chooses them.
static void TTVoicePlaySound(NSString *name, double volume) {
  NSSound *sound = [NSSound soundNamed:name];
  if (!sound) return;
  [sound stop];
  sound.volume = (float)MAX(0, MIN(1, volume));
  [sound play];
}
- (void)chime:(BOOL)starting {
  if (!self.sounds) return;
  TTVoicePlaySound(starting ? self.startSound : self.stopSound, self.soundVolume);
}
// The start sound, once a hold.
- (void)chimeStart {
  if (self.chimed == self.generation) return;
  self.chimed = self.generation;
  [self chime:YES];
}
// The first sound from the microphone: a hold that's listening plays its start sound now.
- (void)micLive:(TTVoiceAudio *)audio {
  if (audio == self.audio && self.phase == TTVoiceListening) [self chimeStart];
}
- (void)startCapture {
  if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] != AVAuthorizationStatusAuthorized) {
    [self fail:@"microphone"]; return; // the overlay shows its microphone card for this one
  }
  TTVoiceAudio *audio = [TTVoiceAudio new];
  __weak TTVoiceCommands *weak = self;
  __weak TTVoiceAudio *heard = audio;
  audio.onLive = ^{ [weak micLive:heard]; };
  self.audio = audio;
  self.inputChanges = 0; self.restarted = NO; self.onDefault = NO;
  [self capture:audio];
}
// Opens the microphone into `audio`.
- (void)capture:(TTVoiceAudio *)audio {
  AVAudioEngine *engine = [AVAudioEngine new];
  self.engine = engine;
  self.runningSince = 0;
  // A Bluetooth headset (AirPods) switches profile when its microphone opens: the input format
  // changes and the engine stops itself. Capture picks up again on the new format.
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(inputChanged:) name:AVAudioEngineConfigurationChangeNotification object:engine];
  dispatch_async(TTVoiceAudioQueue(), ^{ [self tap:engine audio:audio retap:0]; });
}
// tick's watchdog: the microphone sent nothing, so it opens once more into the same audio; on the Mac's own
// input if a chosen one is the silent one.
- (void)restartCapture {
  self.restarted = YES;
  TTVoiceAudio *audio = self.audio;
  AudioObjectID used = TTVoiceInput(), mac = TTVoiceDefaultInput();
  BOOL away = TTVoiceChosenInput() && !self.onDefault && mac != kAudioObjectUnknown && used != mac;
  NSString *from = TTVoiceDeviceString(used, kAudioObjectPropertyName), *to = TTVoiceDeviceString(mac, kAudioObjectPropertyName);
  NSString *next = away ? [NSString stringWithFormat:@"switching to %@", to ?: @"the Mac's input"] : @"opening it again";
  dictate_log([NSString stringWithFormat:@"capture: nothing heard from %@ (%lu buffers, loudest %.4f), %@", from ?: @"?", (unsigned long)audio.buffers, audio.peak, next].UTF8String);
  [self stopCapture];
  if (away) self.onDefault = YES;
  [self capture:audio];
  if (away) dictate_ui_notice([NSString stringWithFormat:@"No sound came from %@, so Dictate is listening through %@ this time.", from ?: @"your microphone", to ?: @"your Mac’s microphone"].UTF8String);
}
// On the audio queue: tap the input as it is now and start the engine. Opening a microphone can take
// a second or more (the headset's profile switch), which must not stall the main thread. `retap` counts the
// tries since the input changed (0: the first time it opens).
- (void)tap:(AVAudioEngine *)engine audio:(TTVoiceAudio *)audio retap:(unsigned)retap {
  if (self.engine != engine) return; // the hold already ended
  NSString *problem = nil;
  @try {
    AVAudioInputNode *input = engine.inputNode;
    [input removeTapOnBus:0];
    if (TTVoiceChosenInput() && !self.onDefault) { // otherwise the engine follows the Mac's input
      AudioObjectID device = TTVoiceInput();
      AudioUnitSetProperty(input.audioUnit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, sizeof(device));
    }
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (!format.channelCount || format.sampleRate <= 0) {
      problem = @"Couldn’t find a microphone.";
    } else {
      AVAudioNodeTapBlock append = ^(AVAudioPCMBuffer *buffer, AVAudioTime *when) { (void)when; [audio append:buffer]; };
      AVAudioFrameCount frames = (AVAudioFrameCount)ceil(format.sampleRate * 0.1);
      NSError *error;
#if defined(__MAC_27_0)
      if (@available(macOS 27.0, *)) {
        if (![input installTapOnBus:0 bufferSize:frames format:nil error:&error block:append]) problem = @"Couldn’t start the microphone.";
      } else { [input installTapOnBus:0 bufferSize:frames format:nil block:append]; }
#else // built with an SDK before macOS 27, which has no error-returning tap
      [input installTapOnBus:0 bufferSize:frames format:nil block:append];
#endif
      if (!problem) {
        [engine prepare];
        if (![engine startAndReturnError:&error]) problem = @"Couldn’t start the microphone.";
      }
    }
  } @catch (NSException *exception) {
    (void)exception;
    problem = @"The microphone changed. Try again.";
  }
  if (self.engine != engine) { [engine stop]; return; } // ended while the microphone was opening
  if (!problem) { self.runningSince = NSProcessInfo.processInfo.systemUptime; return; }
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.engine != engine) return;
    if (self.phase == TTVoiceIdle) { [self stopCapture]; self.audio = nil; return; } // the hold hasn't begun: begin opens it again and says what's wrong
    if (self.phase != TTVoiceListening) return; // let go meanwhile: what was heard goes to speech
    // A microphone mid-switch (a headset changing profile, one plugged in or out) can take a while to come back.
    double wait = tt_retap_delay(retap);
    if (wait > 0) {
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)), TTVoiceAudioQueue(), ^{ [self tap:engine audio:audio retap:retap + 1]; });
    } else if (audio.count >= 8000) { // half a second or more is worth keeping
      dictate_ui_notice("Your microphone cut out, so only what it heard before then is used.");
      self.held = NO; [self finish];
    } else [self fail:problem];
  });
}
- (void)inputChanged:(NSNotification *)note {
  AVAudioEngine *engine = note.object;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (engine != self.engine) return; // a capture that ended has no engine
    self.inputChanges++;
    self.runningSince = 0; // the watchdog waits for it to run again
    TTVoiceAudio *audio = self.audio;
    // Mid-switch the device can report no format for a moment.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), TTVoiceAudioQueue(), ^{ [self tap:engine audio:audio retap:1]; });
  });
}
- (void)transcribe {
  BOOL running = self.engine.isRunning;
  NSData *pcm = [self.audio freeze];
  AVAudioFormat *heard = self.audio.heard;
  NSString *line = [NSString stringWithFormat:@"capture: %.1fs held, %lu buffers, %.0f Hz x%u%@, %lu samples, loudest %.4f, %lu input changes, engine %@, input volume %.2f, input %@",
    NSProcessInfo.processInfo.systemUptime - self.listeningSince, (unsigned long)self.audio.buffers, heard.sampleRate, heard.channelCount, self.audio.channelLevels,
    (unsigned long)(pcm.length / sizeof(float)), self.audio.peak, (unsigned long)self.inputChanges, running ? @"running" : @"stopped", TTVoiceInputVolume(self.onDefault ? TTVoiceDefaultInput() : TTVoiceInput()),
    self.onDefault ? TTVoiceDeviceString(TTVoiceDefaultInput(), kAudioObjectPropertyName) ?: @"?" : TTVoiceInputName()];
  dictate_log(line.UTF8String);
  if (self.audio.failed) { [self fail:@"Couldn’t record that. Try again."]; return; }
  if (self.noting) { // the rest of the note: most of it is in its words already
    if (!dictate_note_finish(self.request.UTF8String, self.audio.dropped, pcm.bytes, pcm.length / sizeof(float))) [self refused];
    self.audio = nil; return;
  }
  if (!pcm.length) {
    // A short hold ends before the first audio arrives (a Bluetooth microphone takes a moment to open).
    BOOL tap = NSProcessInfo.processInfo.systemUptime - self.listeningSince < 1.5;
    [self fail:tap ? @"unheard" : @"No sound came through. Check your microphone in Settings."]; return;
  }
  if (!dictate_audio(self.request.UTF8String, pcm.bytes, pcm.length / sizeof(float))) [self refused];
  self.audio = nil;
}
// Speech turned the audio down: still loading, paused, or busy with the last one.
- (void)refused {
  [self fail:self.modelReady ? @"Couldn’t transcribe that. Try again." : @"The speech model is still loading."];
}
- (void)finish {
  if (self.phase != TTVoiceListening) return;
  self.phase = TTVoiceFinishing;
  if (self.chimed == self.generation) [self chime:NO]; // no stop sound for a microphone that never started
  NSUInteger generation = self.generation;
  // The last syllable is often still being said, and its buffer still on its way, as the key comes up: listen
  // a moment longer, then take the audio only once the engine has stopped and that buffer has landed. Freezing
  // it at once, with the stop still queued, cut the end of the last word. Sound that has been quiet for that
  // long already ends in silence, so it needs no wait (tt_release_tail).
  // ponytail: 0.3 s by ear (Handy keeps 0.45 s after speech), quiet by one RMS threshold; time it by the voice
  // activity if that still clips.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(tt_release_tail(self.audio.quietFor) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (self.generation != generation || self.phase != TTVoiceFinishing) return;
    [self stopCaptureThen:^{
      if (self.generation != generation || self.phase != TTVoiceFinishing) return;
      double patience = tt_words_timeout(self.audio.count);
      [self transcribe];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(patience * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self.generation == generation && self.phase == TTVoiceFinishing) [self fail:@"That took too long. Try again."];
      });
    }];
  });
}
- (void)receiveText:(NSString *)text error:(NSError *)error generation:(NSUInteger)generation {
  if (self.generation != generation || self.phase != TTVoiceFinishing) return;
  if (error) { [self fail:error.localizedDescription ?: @"Couldn’t understand that"]; return; }
  NSString *body = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (!body.length) { [self fail:@"unheard"]; return; } // the overlay's "Didn't catch that"
  if (self.noting) { dictate_ui_note(body.UTF8String); [self cancel]; return; } // to the note's review card
  if (self.commanding) { [self command:body]; return; }
  dictate_ui_said(body.UTF8String, true, false);
  if (!AXIsProcessTrusted()) {
    TTVoiceCopy(body);
    [self fail:@"Dictate needs Accessibility to type, so your words are on the clipboard. Turn it on in System Settings."];
    return;
  }
  // The words go to the app the hold began in. Another in front now (a click on the overlay, or a switch while
  // it transcribed) would get them, or none would: that app comes back first, else they go to the clipboard.
  // A hold begun in this app (the overlay's mic button can bring it forward) still types where you went back to.
  NSRunningApplication *app = self.app;
  if (!app || app.terminated || TTVoiceFront(app) || app.processIdentifier == getpid()) { [self insert:body]; return; }
  TTVoiceBringForward(app, ^(BOOL front) {
    if (self.generation != generation || self.phase != TTVoiceFinishing) return;
    if (front) { [self insert:body]; return; }
    TTVoiceCopy(body);
    dictate_ui_notice([NSString stringWithFormat:@"Couldn’t switch back to %@, so your words are on the clipboard.", app.localizedName ?: @"the app you were in"].UTF8String);
    [self cancel];
  });
}
// The words in at the cursor of the app in front, then Return if this hold sends.
- (void)insert:(NSString *)body {
  // Sending: Return, once every word is in, and only where they went (set below, before the words land).
  __block BOOL send = NO;
  [self insert:body then:^(TTInserted how, pid_t pid) {
    double delay = tt_send_delay(how);
    if (send && delay >= 0) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ TTInsertReturn(pid); });
  }];
  if (!self.typed.length) dictate_ui_notice("There’s nowhere to type here, but Paste Last Transcript has your words.");
  send = self.typed.length && self.sendAfter;
  [self cancel];
}
// A spoken command, with the selection and the app it was said over, for Claude. Its answer comes back
// through dictate_command_result under the same request, which stays known here for that.
- (void)command:(NSString *)instruction {
  NSString *request = self.request;
  if (dictate_command(request.UTF8String, instruction.UTF8String, (self.selection ?: @"").UTF8String, (self.app.bundleIdentifier ?: @"").UTF8String)) {
    TTVoiceRememberCommand(request, self.app);
  } else {
    dictate_ui_notice("Connect AI in Settings › Agents to use commands.");
  }
  self.request = nil; // not forgotten: Claude reads the hold's context while it works
  [self cancel];
}
// Dictation: puts `text` at the cursor of the app in front, once, pasted (or typed where pasting is unreliable,
// insert.m). `then` runs on the main thread once the words are in, with how they went in and the app they went to.
- (void)insert:(NSString *)text then:(void (^)(TTInserted how, pid_t pid))then {
  pid_t app = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  // A click on the overlay brings this app forward for a moment: the words wait for theirs to come back.
  if (app == getpid() && self.app.processIdentifier != app) return;
  id field = TTVoiceFocusedField();
  if (app == getpid() && !TTVoiceTextField(field)) return;
  BOOL continues = self.dictated.length && app == self.dictatedApp && TTVoiceSameField(field, self.dictatedField);
  if (!continues) { self.dictated = nil; self.dictatedApp = app; self.dictatedField = field; }
  BOOL spaced = !continues || [NSCharacterSet.whitespaceAndNewlineCharacterSet characterIsMember:[self.dictated characterAtIndex:self.dictated.length - 1]];
  self.lead = spaced ? @"" : @" ";
  self.typed = [self.lead stringByAppendingString:text];
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  TTInsertText(self.typed, front.processIdentifier, front.bundleIdentifier, ^(TTInserted how) { if (then) then(how, front.processIdentifier); });
}
// The overlay's note button: the mic's talk with no minute cap, transcribed while it is said.
- (void)toggleNote {
  if (self.phase == TTVoiceIdle) self.noting = YES;
  [self toggleTalk];
  if (self.phase == TTVoiceIdle) self.noting = NO;
}
// The overlay's mic button: talk without holding fn. The next press sends; ✕ or Escape cancels.
- (void)toggleTalk {
  if (self.phase == TTVoiceListening) { self.held = NO; [self finish]; return; }
  if (self.phase != TTVoiceIdle) return;
  self.held = YES; self.blocked = NO;
  [self begin];
  if (self.phase != TTVoiceListening) self.held = NO;
}
// Locked listening, from a double tap: no key to hold, up to ten minutes. A tap sends; Escape cancels.
- (void)lock {
  self.locked = YES; self.commanding = NO; self.dictating = YES;
  [self begin];
  if (self.phase == TTVoiceListening) dictate_ui_hands_free(true);
  else self.locked = NO;
}
- (void)send {
  if (self.phase != TTVoiceListening) return;
  self.held = NO; [self finish];
}
// Send from the overlay's button: the click brought this app forward, so the app the words go to
// comes back first.
- (void)sendFromOverlay {
  if (self.phase != TTVoiceListening) return;
  pid_t me = NSRunningApplication.currentApplication.processIdentifier;
  if (!TTVoiceFront(NSRunningApplication.currentApplication) || self.app.processIdentifier == me) { [self send]; return; }
  NSUInteger generation = self.generation;
  TTVoiceBringForward(self.app, ^(BOOL front) { (void)front; if (self.generation == generation) [self send]; });
}
- (void)openEarly {
  if (self.phase == TTVoiceIdle && !self.blocked && self.modelReady && !self.engine
      && [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] == AVAuthorizationStatusAuthorized) [self startCapture];
}
// Escape from its hot key, while listening or transcribing (TTVoiceCatchEscape): as from the monitor below.
- (void)escape {
  tt_taps_reset(&_taps);
  self.blocked = YES; [self cancel];
}
// `inApp`: from the local monitor, which hears this app's own windows.
- (BOOL)handleEvent:(NSEvent *)event inApp:(BOOL)inApp {
  CGEventRef raw = event.CGEvent;
  if (event.type == NSEventTypeKeyDown && raw && (CGEventGetIntegerValueField(raw, kCGEventSourceUserData) == TTVoiceMark || CGEventGetIntegerValueField(raw, kCGEventSourceUnixProcessID) == getpid())) return NO;
  BOOL mouse = event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeRightMouseDown;
  if (mouse && inApp && event.window && event.window == TTVoiceOverlayWindow()) return NO; // the overlay's own buttons
  // Any click or key of the person's own after our words went in can move the caret.
  if (event.type != NSEventTypeFlagsChanged) { if (self.typed.length) self.typingStopped = YES; self.dictated = nil; }
  if (mouse) {
    // A click with the key down (a shift-click, a command-click) is a shortcut, as a key would be.
    if (self.enabled && self.pressed) {
      if (self.held && self.phase != TTVoiceSubmitting) { self.blocked = YES; tt_taps_reset(&_taps); [self cancel]; }
      else if (self.locked) self.blocked = YES; // and its release then doesn't send
    }
    return NO;
  }
  uint16_t code = tt_key_code(self.key);
  BOOL pressed = event.type == NSEventTypeFlagsChanged && event.keyCode == code ? tt_key_down(self.key, event.modifierFlags) : self.pressed;
  BOOL changed = pressed != self.pressed;
  // The key always reaches the pages, so setup and Shortcuts can test it before voice is on.
  if (changed) { self.pressed = pressed; dictate_ui_fn(pressed); }
  if (event.type == NSEventTypeKeyDown) {
    if (self.enabled) {
      tt_taps_reset(&_taps); // keys between taps are typing, not a double tap
      if (event.keyCode == 53) { self.blocked = YES; if (self.phase != TTVoiceSubmitting) [self cancel]; }
      // The key with another is a shortcut. A talk or note started from the overlay holds no key, so typing goes on.
      else if (self.held && self.pressed && self.phase != TTVoiceSubmitting) { self.blocked = YES; [self cancel]; }
      else if (self.locked && self.pressed) self.blocked = YES; // and its release then doesn't send
    }
    // In this app only while the overlay is key, so Settings can record a chord without running it.
    if (event.isARepeat || (inApp && (!event.window || event.window != TTVoiceOverlayWindow()))) return NO;
    return [self chord:event];
  }
  if (!self.enabled || event.type != NSEventTypeFlagsChanged) return NO;
  // The key alone dictates; with the command modifier it talks to Claude; with anything else it is a shortcut.
  TTHold kind = tt_hold_kind(tt_key_others(self.key, event.modifierFlags), self.commandFlag);
  if (self.held && self.pressed && kind != TTHoldPlain && self.phase != TTVoiceSubmitting) {
    // The modifier can join until the hold begins, so pressing both at once works in either order.
    if (kind == TTHoldCommand && (self.commanding || self.phase == TTVoiceIdle)) { self.commanding = YES; self.dictating = NO; }
    else { self.blocked = YES; tt_taps_reset(&_taps); [self cancel]; }
  } else if (self.locked && self.pressed && kind != TTHoldPlain) self.blocked = YES;
  if (!changed) return NO;
  if (pressed) {
    tt_taps_press(&_taps, event.timestamp);
    if (self.locked) return NO; // its release sends
    self.held = YES;
    NSUInteger gesture = ++self.gesture;
    self.blocked = kind == TTHoldShortcut;
    self.commanding = kind == TTHoldCommand;
    if (self.phase == TTVoiceIdle) self.dictating = !self.commanding;
    // The microphone opens before the hold begins, so the first words are not cut off; a tap or a
    // shortcut closes it unheard. A right-hand modifier is often the start of a shortcut, so it waits a
    // moment: opening for each one would flash the microphone indicator and switch a headset's profile.
    if (self.key == TTKeyFn) [self openEarly];
    else dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ if (self.gesture == gesture) [self openEarly]; });
    // With hands-free on, a hold begins only once it is too long to be a tap, so taps never record.
    double wait = self.handsFree ? TT_TAP : 0.18;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      if (self.gesture == gesture) [self begin];
    });
    return NO;
  }
  TTTap tap = tt_taps_release(&_taps, event.timestamp);
  BOOL blocked = self.blocked;
  self.blocked = NO;
  if (self.locked) {
    if (!blocked) { tt_taps_reset(&_taps); [self send]; }
    return NO;
  }
  self.held = NO;
  NSUInteger gesture = ++self.gesture;
  if (self.handsFree && !blocked && self.phase == TTVoiceIdle && self.enabled) {
    if (tap == TTTapDouble) { [self lock]; return NO; }
    // A first tap: the microphone stays open a moment, so words right after a second one are heard.
    if (tap == TTTapSingle) {
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(TT_DOUBLE_TAP * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self.gesture == gesture && self.phase == TTVoiceIdle) { [self stopCapture]; self.audio = nil; }
      });
      return NO;
    }
  }
  if (self.phase == TTVoiceIdle) { [self stopCapture]; self.audio = nil; } // the hold never began
  [self finish];
  return NO;
}
// The global shortcuts from Settings › Shortcuts. True when `event` is one of them.
- (BOOL)chord:(NSEvent *)event {
  for (NSString *name in self.chords) {
    NSArray<NSNumber *> *chord = self.chords[name];
    if (!tt_chord_matches(event.keyCode, event.modifierFlags, chord[0].unsignedShortValue, chord[1].unsignedLongLongValue)) continue;
    if ([name isEqual:@"note"]) {
      if (!self.enabled) dictate_ui_notice("Dictation is paused.");
      else if (self.phase == TTVoiceIdle || (self.noting && self.phase == TTVoiceListening)) [self toggleNote];
    } else if ([name isEqual:@"meeting"]) {
      if (!dictate_meeting("stop") && !dictate_meeting("start")) dictate_meeting_unstarted(); // says why, unless the microphone card does
    } else if ([name isEqual:@"pasteLast"]) {
      dictate_paste_last();
    } else {
      dictate_ui_open(name.UTF8String); // a note to type, a sticky, or a question for Claude
    }
    return YES;
  }
  return NO;
}
- (void)monitor {
  if (self.localMonitor) [NSEvent removeMonitor:self.localMonitor];
  if (self.globalMonitor) [NSEvent removeMonitor:self.globalMonitor];
  self.trusted = AXIsProcessTrusted();
  __weak TTVoiceCommands *weak = self;
  // Key presses are heard only while voice is on or a chord is set; clicks only while voice is on.
  NSEventMask mask = self.enabled ? NSEventMaskFlagsChanged | NSEventMaskKeyDown | NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown
    : self.chords.count ? NSEventMaskFlagsChanged | NSEventMaskKeyDown : NSEventMaskFlagsChanged;
  self.localMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
    BOOL cancel = event.type == NSEventTypeKeyDown && event.keyCode == 53 && weak.phase != TTVoiceIdle;
    return [weak handleEvent:event inApp:YES] || cancel ? nil : event;
  }];
  self.globalMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *event) { [weak handleEvent:event inApp:NO]; }];
}
// The settings, each time they change: the keys, live typing and the sounds.
- (void)apply:(NSDictionary *)settings {
  self.settings = settings;
  NSDictionary *keys = TTVoiceObject(settings[@"shortcuts"]), *dictation = TTVoiceObject(settings[@"dictation"]), *claude = TTVoiceObject(settings[@"claude"]);
  NSUInteger index = [@[@"fn", @"rightCommand", @"rightOption", @"rightControl", @"rightShift"] indexOfObject:keys[@"dictate"] ?: @"fn"];
  TTKey key = index == NSNotFound ? TTKeyFn : (TTKey)index;
  // The old key's release never comes: a hold of it ends, while a note, a locked session or words on
  // their way, which no key holds, go on.
  if (key != self.key) {
    if (self.pressed) {
      if (self.held && !self.noting && !self.locked && self.phase != TTVoiceFinishing && self.phase != TTVoiceSubmitting) { [self cancel]; self.held = NO; }
      self.pressed = NO; dictate_ui_fn(false);
    }
    self.blocked = NO; tt_taps_reset(&_taps);
    self.key = key;
  }
  NSDictionary *flags = @{@"control": @(NSEventModifierFlagControl), @"option": @(NSEventModifierFlagOption), @"command": @(NSEventModifierFlagCommand), @"shift": @(NSEventModifierFlagShift)};
  // Until Claude is connected the modifier makes a shortcut, as any other does, not a command no one
  // answers.
  self.commandFlag = [claude[@"enabled"] isEqual:@YES] && ![claude[@"commands"] isEqual:@NO] ? [flags[keys[@"command"] ?: @"control"] unsignedIntegerValue] : 0;
  self.handsFree = ![keys[@"handsFree"] isEqual:@NO];
  self.sounds = ![dictation[@"sounds"] isEqual:@NO];
  NSDictionary *appearance = TTVoiceObject(settings[@"appearance"]);
  BOOL avoidDock = ![appearance[@"avoidDock"] isEqual:@NO];
  if (avoidDock != TTOverlayAvoidsDock) { TTOverlayAvoidsDock = avoidDock; TTOverlayFit(); }
  self.soundVolume = [dictation[@"soundVolume"] isKindOfClass:NSNumber.class] ? [dictation[@"soundVolume"] doubleValue] : 0.3;
  if ([dictation[@"startSound"] isKindOfClass:NSString.class]) self.startSound = dictation[@"startSound"];
  if ([dictation[@"stopSound"] isKindOfClass:NSString.class]) self.stopSound = dictation[@"stopSound"];
  NSMutableDictionary *chords = [NSMutableDictionary new];
  for (NSString *name in @[@"note", @"meeting", @"pasteLast", @"writeNote", @"sticky", @"ask"]) {
    NSDictionary *chord = TTVoiceObject(keys[name]);
    if ([chord[@"keyCode"] isKindOfClass:NSNumber.class] && [chord[@"modifiers"] isKindOfClass:NSNumber.class]) chords[name] = @[chord[@"keyCode"], chord[@"modifiers"]];
  }
  BOOL listened = self.chords.count != 0;
  self.chords = chords;
  if (self.localMonitor && listened != (chords.count != 0)) [self monitor];
  [self globe];
}
// The globe key's own action, held while fn dictates. Not before the settings say which key dictates: the first
// time they do is the launch.
- (void)globe {
  static BOOL started;
  if (!self.settings) return;
  TTGlobeSync(self.enabled && self.key == TTKeyFn, !started);
  started = YES;
}
- (void)watchTrust {
  // A global monitor only hears other apps once Accessibility is on; reinstall it when that changes.
  __weak TTVoiceCommands *weak = self;
  self.trustTimer = [NSTimer timerWithTimeInterval:2 repeats:YES block:^(NSTimer *timer) {
    (void)timer;
    if (AXIsProcessTrusted() != weak.trusted) [weak monitor];
  }];
  [NSRunLoop.mainRunLoop addTimer:self.trustTimer forMode:NSRunLoopCommonModes];
}
- (void)prepareModels {
  self.modelReady = NO; self.modelPreparing = YES;
  self.modelMessage = @"Getting Whisper large-v3 Turbo ready…";
  dictate_prepare_models();
}
- (void)applyEnabled:(BOOL)enabled {
  if (self.enabled == enabled) {
    if (enabled && !self.modelReady && !self.modelPreparing) [self prepareModels]; // the last download or load failed
    return;
  }
  [self cancel]; self.held = NO; self.blocked = NO;
  self.enabled = enabled;
  [NSUserDefaults.standardUserDefaults setBool:self.enabled forKey:@"DictateEnabled"];
  [self globe];
  [self monitor];
  if (self.enabled) [self prepareModels];
  else {
    self.modelReady = NO; self.modelPreparing = NO; self.modelMessage = @"Dictation is paused. The speech model stays downloaded.";
    dictate_disable_models();
  }
}
@end

// ---------- The overlay window: blur behind the page's cards, clicks through everywhere else ----------

@interface TTVoiceOverlay : NSObject
@property (weak) NSWindow *window;
@property (strong) NSMutableArray<NSVisualEffectView *> *glass;
@property (copy) NSArray<NSValue *> *hits;
@property (strong) NSMutableDictionary<NSNumber *, NSImage *> *masks;
@property (strong) NSTimer *mouseTimer;
@property BOOL shown, pointerOver;
// The Dock that hides itself: its strip and edge (read every few seconds), whether it is out right now, and the clocks behind that.
@property CGFloat dockStrip;
@property NSRectEdge dockEdge;
@property BOOL dockShown, dockPushed;
@property CFAbsoluteTime dockRead, dockLeft, dockPolled;
@property NSPoint pointer;
@end

@implementation TTVoiceOverlay
- (NSView *)webView {
  NSView *root = self.window.contentView;
  if (!root) return nil; // the window can close before the timer asking for it stops
  NSMutableArray<NSView *> *queue = [NSMutableArray arrayWithObject:root];
  Class webClass = NSClassFromString(@"WKWebView");
  while (queue.count) {
    NSView *view = queue.firstObject; [queue removeObjectAtIndex:0];
    if ([view isKindOfClass:webClass]) return view;
    [queue addObjectsFromArray:view.subviews];
  }
  return nil;
}
static const char *TTEdgeName(NSRectEdge edge) { return edge == NSRectEdgeMinX ? "left" : edge == NSRectEdgeMaxX ? "right" : "bottom"; }
/// Which edge the Dock's own preference puts it on.
static NSRectEdge TTDockEdgeFromPreferences(void) {
  NSString *side = (__bridge_transfer NSString *)CFPreferencesCopyAppValue(CFSTR("orientation"), CFSTR("com.apple.dock"));
  return [side isEqualToString:@"left"] ? NSRectEdgeMinX : [side isEqualToString:@"right"] ? NSRectEdgeMaxX : NSRectEdgeMinY;
}
/// Without leave to read the Dock, its own preferences say enough: a Dock that hides itself, on which edge,
/// and how big its tiles are; its strip is the tile plus the padding around it (47 points at a tile of 26).
static CGFloat TTDockStripFromPreferences(NSRectEdge *edge) {
  NSNumber *hides = (__bridge_transfer NSNumber *)CFPreferencesCopyAppValue(CFSTR("autohide"), CFSTR("com.apple.dock"));
  if (![hides respondsToSelector:@selector(boolValue)] || !hides.boolValue) return 0; // a Dock that stays reserves its space itself
  NSNumber *tile = (__bridge_transfer NSNumber *)CFPreferencesCopyAppValue(CFSTR("tilesize"), CFSTR("com.apple.dock"));
  CGFloat size = [tile respondsToSelector:@selector(doubleValue)] ? MAX(16.0, MIN(128.0, tile.doubleValue)) : 48.0;
  *edge = TTDockEdgeFromPreferences();
  return size + 21.0;
}
/// The Dock's one list in its accessibility tree (the Dock itself), or NULL without leave to ask. The caller releases it.
static AXUIElementRef TTDockList(void) {
  NSRunningApplication *dock = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.dock"].firstObject;
  if (!dock || !AXIsProcessTrusted()) return NULL;
  AXUIElementRef app = AXUIElementCreateApplication(dock.processIdentifier);
  CFArrayRef children = NULL; AXUIElementRef list = NULL;
  if (AXUIElementCopyAttributeValue(app, kAXChildrenAttribute, (CFTypeRef *)&children) == kAXErrorSuccess && children) {
    for (CFIndex i = 0; i < CFArrayGetCount(children) && !list; i++) {
      AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, i);
      CFTypeRef role = NULL;
      if (AXUIElementCopyAttributeValue(child, kAXRoleAttribute, &role) == kAXErrorSuccess && role) {
        if (CFEqual(role, kAXListRole)) list = (AXUIElementRef)CFRetain(child);
        CFRelease(role);
      }
    }
    CFRelease(children);
  }
  CFRelease(app);
  return list;
}
/// Where the Dock's list is right now, in screen points from the bottom left of the main screen: on the
/// screen while it is out, mostly past its edge while it hides. Empty when it cannot be read.
static NSRect TTDockListFrame(void) {
  AXUIElementRef list = TTDockList();
  if (!list) return NSZeroRect;
  CFTypeRef position = NULL, size = NULL;
  NSRect frame = NSZeroRect;
  if (AXUIElementCopyAttributeValue(list, kAXPositionAttribute, &position) == kAXErrorSuccess && position
      && AXUIElementCopyAttributeValue(list, kAXSizeAttribute, &size) == kAXErrorSuccess && size) {
    CGPoint origin = CGPointZero; CGSize box = CGSizeZero;
    AXValueGetValue((AXValueRef)position, kAXValueTypeCGPoint, &origin);
    AXValueGetValue((AXValueRef)size, kAXValueTypeCGSize, &box);
    CGFloat height = NSHeight(NSScreen.screens.firstObject.frame); // accessibility measures down from the top left of the main screen
    frame = NSMakeRect(origin.x, height - origin.y - box.height, box.width, box.height);
  }
  if (position) CFRelease(position);
  if (size) CFRelease(size);
  CFRelease(list);
  return frame;
}
/// The Dock's strip on the screen that has it: its edge and thickness, from the Dock's own accessibility
/// tree, which reports its size while it is hidden too; from its preferences without leave to ask. Zero
/// when there is no Dock.
static CGFloat TTDockStrip(NSRectEdge *edge) {
  if (![NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.dock"].firstObject) return 0;
  if (!AXIsProcessTrusted()) return TTDockStripFromPreferences(edge);
  NSRect list = TTDockListFrame();
  if (NSIsEmptyRect(list)) return 0;
  // Along the bottom it is wide; at a side it is tall. Which side, the Dock's own preference says.
  if (NSWidth(list) >= NSHeight(list)) { *edge = NSRectEdgeMinY; return NSHeight(list); }
  *edge = TTDockEdgeFromPreferences();
  return NSWidth(list);
}
- (void)fitScreen {
  NSScreen *screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
  if (!screen) return;
  // The visible frame stops at a Dock that stays. A Dock that hides itself reserves nothing, so the dots sit
  // at the edge and step aside while it is out (readDock, track), rather than keeping its strip empty all day.
  NSRect fit = TTOverlayAvoidsDock ? screen.visibleFrame : screen.frame;
  // macOS posts screen-parameter changes in bursts, about 120 a second while the Dock slides, with nothing
  // changed for the overlay: an unchanged frame needs no new frame, no log line and no Dock read, which is an
  // Accessibility call into the busy Dock on the main thread the hover and the voice run on. The Dock is read
  // every few seconds anyway (watchDock), and when the setting that decides the fit changes (TTOverlayFit).
  if (self.dockRead && NSEqualRects(fit, self.window.frame)) return;
  dictate_log([NSString stringWithFormat:@"overlay: fitted to %.0f × %.0f at %.0f, %.0f (clear of the Dock: %@)", fit.size.width, fit.size.height, fit.origin.x, fit.origin.y, TTOverlayAvoidsDock ? @"yes" : @"no"].UTF8String);
  [self.window setFrame:fit display:YES];
  [self readDock];
}
/// The Dock that hides itself, on the screen with the menu bar: its edge and strip, kept fresh every few
/// seconds and on every screen change. A Dock that stays has its space already (fitScreen), so it counts as none.
- (void)readDock {
  self.dockRead = CFAbsoluteTimeGetCurrent();
  NSScreen *main = NSScreen.screens.firstObject;
  if (!main) return;
  NSRectEdge edge = NSRectEdgeMinY;
  CGFloat strip = TTOverlayAvoidsDock ? TTDockStrip(&edge) : 0;
  NSRect whole = main.frame, visible = main.visibleFrame;
  BOOL hides = strip > 0 && (edge == NSRectEdgeMinY ? NSMinY(visible) == NSMinY(whole) : edge == NSRectEdgeMinX ? NSMinX(visible) == NSMinX(whole) : NSMaxX(visible) == NSMaxX(whole));
  if (!hides) strip = 0;
  if (strip == self.dockStrip && edge == self.dockEdge) return;
  self.dockStrip = strip; self.dockEdge = edge;
  dictate_log([NSString stringWithFormat:@"dock: %@", strip > 0 ? [NSString stringWithFormat:@"hides at the %s, a strip of %.0f; the dots step aside while it is out", TTEdgeName(edge), strip] : @"stays, or there is none to step aside for"].UTF8String);
  if (!strip && self.dockShown) { self.dockShown = NO; self.dockPushed = NO; dictate_ui_dock(false, 0, TTEdgeName(edge)); }
}
/// Is the Dock out? With leave to read the Dock, the Dock itself says whether it is on the screen, asked
/// at most ten times a second while the pointer is anywhere near its edge or the dots have stepped
/// aside. Without, the pointer says: the Dock comes out when the pointer pushes its edge and goes a
/// moment after the pointer leaves its neighbourhood, which is wider than its strip (the pointer on the
/// lifted dots is still beside the Dock). And while the pointer is on the dots or the pill, nothing
/// moves: the pill must never slide out from under the pointer because the Dock went.
- (void)watchDock:(CFAbsoluteTime)now {
  if (now - self.dockRead > 5) [self readDock];
  if (self.dockStrip <= 0) return;
  NSRect whole = NSScreen.screens.firstObject.frame;
  NSPoint at = NSEvent.mouseLocation;
  NSRectEdge edge = self.dockEdge;
  CGFloat depth = edge == NSRectEdgeMinY ? at.y - NSMinY(whole) : edge == NSRectEdgeMinX ? at.x - NSMinX(whole) : NSMaxX(whole) - at.x;
  BOOL onMain = NSPointInRect(at, NSInsetRect(whole, -1, -1));
  BOOL atEdge = onMain && depth <= 1.5, near = onMain && depth <= self.dockStrip * 2 + 24;
  BOOL shown = self.dockShown;
  if (atEdge) self.dockPushed = YES;
  if (self.pointerOver) {
    self.dockLeft = 0; // hold still under the pointer
  } else if (AXIsProcessTrusted()) {
    if ((near || shown) && now - self.dockPolled > 0.1) {
      self.dockPolled = now;
      NSRect list = TTDockListFrame();
      if (!NSIsEmptyRect(list)) { NSRect seen = NSIntersectionRect(list, whole); shown = NSWidth(seen) * NSHeight(seen) > 0.5 * NSWidth(list) * NSHeight(list); }
    }
    if (!shown) self.dockPushed = NO;
  } else if (self.dockPushed && near) {
    self.dockLeft = 0;
    shown = YES;
  } else if (shown || self.dockPushed) {
    // Gone from the Dock's neighbourhood: it slides back a moment later.
    if (!self.dockLeft) self.dockLeft = now;
    if (now - self.dockLeft > 0.25) { shown = NO; self.dockPushed = NO; self.dockLeft = 0; }
  }
  if (shown != self.dockShown) { self.dockShown = shown; dictate_ui_dock(shown, self.dockStrip, TTEdgeName(edge)); }
}
- (void)attach:(NSWindow *)window {
  self.window = window;
  self.glass = [NSMutableArray new];
  self.masks = [NSMutableDictionary new];
  self.hits = @[];
  window.level = NSStatusWindowLevel;
  window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary
    | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
  window.hasShadow = NO; window.opaque = NO; window.backgroundColor = NSColor.clearColor;
  window.excludedFromWindowsMenu = YES;
  window.ignoresMouseEvents = YES;
  [self fitScreen];
  // Shown on the page's first layout report, never before: until the overlay page has mounted, the
  // window holds the server-rendered app shell, a full-screen dark loading frame.
  self.shown = NO;
  __weak TTVoiceOverlay *weak = self;
  [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { (void)note; [weak fitScreen]; }];
  [self.mouseTimer invalidate];
  self.mouseTimer = [NSTimer timerWithTimeInterval:1.0 / 60 repeats:YES block:^(NSTimer *timer) { (void)timer; [weak track]; }];
  [NSRunLoop.mainRunLoop addTimer:self.mouseTimer forMode:NSRunLoopCommonModes];
}
- (void)track {
  NSWindow *window = self.window;
  NSView *web = [self webView];
  if (!window || !web) { [self.mouseTimer invalidate]; self.mouseTimer = nil; return; }
  [self watchDock:CFAbsoluteTimeGetCurrent()];
  NSPoint point = [web convertPoint:[window convertPointFromScreen:NSEvent.mouseLocation] fromView:nil];
  BOOL over = NO;
  for (NSValue *hit in self.hits) if (NSPointInRect(point, hit.rectValue)) { over = YES; break; }
  BOOL dragging = NSEvent.pressedMouseButtons != 0 && !window.ignoresMouseEvents;
  BOOL ignore = !(over || dragging);
  if (window.ignoresMouseEvents != ignore) {
    window.ignoresMouseEvents = ignore;
    TTLookAgain();
  }
  // WebKit sends no hover to a window that isn't key, and the overlay never is while another app is
  // in front, so the page hears the pointer from here.
  if (over != self.pointerOver || (over && !NSEqualPoints(point, self.pointer))) {
    self.pointerOver = over; self.pointer = point;
    dictate_ui_pointer(over, point.x, point.y);
  }
}
// A behind-window blur is drawn by the window server, so a layer corner radius does not clip it; a
// stretchable mask image does.
- (NSImage *)mask:(CGFloat)radius {
  CGFloat r = MAX(1, round(radius * 2) / 2);
  NSImage *cached = self.masks[@(r)];
  if (cached) return cached;
  NSImage *image = [NSImage imageWithSize:NSMakeSize(r * 2 + 1, r * 2 + 1) flipped:NO drawingHandler:^BOOL(NSRect rect) {
    [NSColor.blackColor setFill];
    [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:r yRadius:r] fill];
    return YES;
  }];
  image.capInsets = NSEdgeInsetsMake(r, r, r, r);
  image.resizingMode = NSImageResizingModeStretch;
  self.masks[@(r)] = image;
  return image;
}
static BOOL TTVoiceNumbers(id row, NSUInteger count) {
  if (![row isKindOfClass:NSArray.class] || [row count] != count) return NO;
  for (id value in row) if (![value isKindOfClass:NSNumber.class] || !isfinite([value doubleValue])) return NO;
  return YES;
}
// The overlay's parts are small. Anything covering most of the screen is a broken page, never something
// to blur or to take clicks for.
- (BOOL)modest:(NSArray *)row {
  NSSize size = self.window.frame.size;
  return [row[2] doubleValue] * [row[3] doubleValue] <= size.width * size.height * 0.6;
}
- (void)layout:(NSDictionary *)values {
  NSView *web = [self webView];
  if (!web) return;
  NSMutableArray<NSValue *> *hits = [NSMutableArray new];
  for (id row in values[@"hit"]) if (TTVoiceNumbers(row, 4) && [self modest:row]) [hits addObject:[NSValue valueWithRect:NSMakeRect([row[0] doubleValue], [row[1] doubleValue], [row[2] doubleValue], [row[3] doubleValue])]];
  self.hits = hits;
  NSMutableArray *glass = [NSMutableArray new];
  for (id row in values[@"glass"]) if (TTVoiceNumbers(row, 6) && [self modest:row]) [glass addObject:row];
  // ponytail: material picked by eye; `defaults write <bundle id> DictateGlassMaterial hud` to compare.
  NSString *material = [NSUserDefaults.standardUserDefaults stringForKey:@"DictateGlassMaterial"];
  while (self.glass.count < glass.count) {
    NSVisualEffectView *view = [NSVisualEffectView new];
    view.material = [material isEqual:@"hud"] ? NSVisualEffectMaterialHUDWindow : [material isEqual:@"popover"] ? NSVisualEffectMaterialPopover : NSVisualEffectMaterialFullScreenUI;
    view.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    view.state = NSVisualEffectStateActive;
    [web.superview addSubview:view positioned:NSWindowBelow relativeTo:web];
    [self.glass addObject:view];
  }
  // The blur follows the page's theme, which can differ from the Mac's.
  NSAppearance *appearance = [NSAppearance appearanceNamed:[values[@"dark"] isEqual:@NO] ? NSAppearanceNameAqua : NSAppearanceNameDarkAqua];
  for (NSVisualEffectView *view in self.glass) if (![view.appearance isEqual:appearance]) view.appearance = appearance;
  for (NSUInteger i = 0; i < self.glass.count; i++) {
    NSVisualEffectView *view = self.glass[i];
    if (i >= glass.count) { view.hidden = YES; continue; }
    NSArray *row = glass[i];
    NSRect rect = NSMakeRect([row[0] doubleValue], [row[1] doubleValue], [row[2] doubleValue], [row[3] doubleValue]);
    view.hidden = NO;
    view.frame = [web.superview convertRect:rect fromView:web];
    view.alphaValue = MAX(0, MIN(1, [row[5] doubleValue]));
    view.maskImage = [self mask:[row[4] doubleValue]];
  }
  if (!self.shown && self.window) { self.shown = YES; [self.window orderFrontRegardless]; }
}
@end

// ---------- C API (app/ and dictation/speech.rs) ----------

static TTVoiceCommands *voice;
static TTVoiceOverlay *overlay;
static void TTOverlayFit(void) { [overlay fitScreen]; [overlay readDock]; } // the Dock's strip counts only while the overlay keeps clear of it
static NSWindow *TTVoiceOverlayWindow(void) { return overlay.window; }

// Escape cancels while listening or transcribing, and goes no further: a hot key takes it before the app in
// front sees it, where the key monitor only watches it go by (and the app behind closed its dialog too). It is
// taken only then, and any other time Escape is the app's.
static EventHotKeyRef TTVoiceEscapeKey;
static const OSType TTVoiceEscapeSignature = 0x54546573; // 'TTes'
static OSStatus TTVoiceEscapePressed(EventHandlerCallRef next, EventRef event, void *data) {
  (void)next; (void)data;
  EventHotKeyID key = { 0, 0 };
  if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof(key), NULL, &key) != noErr || key.signature != TTVoiceEscapeSignature) return eventNotHandledErr;
  if (voice.phase == TTVoiceListening || voice.phase == TTVoiceFinishing) [voice escape];
  return noErr;
}
static void TTVoiceCatchEscape(BOOL on) {
  if (on == (TTVoiceEscapeKey != NULL)) return;
  if (!on) { UnregisterEventHotKey(TTVoiceEscapeKey); TTVoiceEscapeKey = NULL; return; }
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    EventTypeSpec pressed = { kEventClassKeyboard, kEventHotKeyPressed };
    InstallApplicationEventHandler(TTVoiceEscapePressed, 1, &pressed, NULL, NULL);
  });
  EventHotKeyID key = { TTVoiceEscapeSignature, 1 };
  if (RegisterEventHotKey(kVK_Escape, 0, key, GetApplicationEventTarget(), 0, &TTVoiceEscapeKey) != noErr) TTVoiceEscapeKey = NULL;
}

static NSDictionary *appliedSettings; // settings that arrived before the voice object

void dictate_init(void) {
  if (voice) return;
  voice = [TTVoiceCommands new];
  voice.enabled = [NSUserDefaults.standardUserDefaults boolForKey:@"DictateEnabled"];
  [voice apply:appliedSettings]; // the globe key's action is settled here if the settings are in, else as they arrive
  // It is the person's again whenever the app ends: Tauri can exit without the notification.
  [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationWillTerminateNotification object:nil queue:nil usingBlock:^(NSNotification *note) { (void)note; TTGlobeGiveBack(); }];
  atexit(TTGlobeGiveBack);
  [voice monitor];
  [voice watchTrust];
  if (voice.enabled) [voice prepareModels];
  [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceWillSleepNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { (void)note; [voice cancel]; voice.held = NO; }];
  [NSDistributedNotificationCenter.defaultCenter addObserverForName:@"com.apple.screenIsLocked" object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { (void)note; [voice cancel]; voice.held = NO; }];
}
// ---------- The globe key's own action ----------
// "Press 🌐 key to" (System Settings › Keyboard) runs in the window server ahead of every app, so with fn as
// the dictate key a hold also opened the emoji viewer or switched the input source. While fn dictates it is
// held at Do Nothing, as OpenWhispr does (resources/macos-globe-listener.swift), and put back as the person had
// it when the key changes, dictation pauses or the app quits. The original is saved in the app's own defaults
// before anything changes, so a crash can't lose it: the next launch puts it back, or keeps holding it.
// TISGetFnUsageType and TISUpdateFnUsageType are private API (System Settings' own; writing the preference
// directly applies only at the next login), so this must stay out of any Mac App Store build.
static NSString *const TTGlobeOriginal = @"TTGlobeOriginal"; // {value, existed}: the action, and whether it was set at all
static int (*TTGlobeGet)(void);
static void (*TTGlobeSet)(int);
static BOOL TTGlobeLoaded(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    void *get = dlsym(RTLD_DEFAULT, "TISGetFnUsageType"), *set = dlsym(RTLD_DEFAULT, "TISUpdateFnUsageType");
    if (get && set) { TTGlobeGet = (int (*)(void))get; TTGlobeSet = (void (*)(int))set; }
  });
  return TTGlobeGet != NULL;
}
static CFStringRef const TTGlobeDomain = CFSTR("com.apple.HIToolbox"), TTGlobeKey = CFSTR("AppleFnUsageType");
// Unset, macOS works the action out itself; read fresh, as CFPreferences keeps another app's domain cached.
static BOOL TTGlobeWasSet(void) {
  CFPreferencesSynchronize(TTGlobeDomain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
  CFPropertyListRef value = CFPreferencesCopyValue(TTGlobeKey, TTGlobeDomain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
  if (value) CFRelease(value);
  return value != NULL;
}
static NSNumber *TTGlobeSaved(void) {
  NSDictionary *saved = TTVoiceObject([NSUserDefaults.standardUserDefaults objectForKey:TTGlobeOriginal]);
  return [saved[@"value"] isKindOfClass:NSNumber.class] ? saved[@"value"] : nil;
}
// `want`: fn is the dictate key and dictation is on. `launch`: once as the app starts.
static void TTGlobeSync(BOOL want, BOOL launch) {
  if (!TTGlobeLoaded()) return; // setup asks the person to change it instead
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  NSNumber *saved = TTGlobeSaved();
  int now = TTGlobeGet();
  TTGlobe step = tt_globe_step(want, saved != nil, now, launch);
  if (step == TTGlobeTake) {
    [defaults setObject:@{@"value": @(now), @"existed": @(TTGlobeWasSet())} forKey:TTGlobeOriginal];
    CFPreferencesAppSynchronize(kCFPreferencesCurrentApplication); // saved before it changes
    TTGlobeSet(0);
    dictate_log([NSString stringWithFormat:@"globe key: held at Do Nothing while fn dictates (it was %d)", now].UTF8String);
  } else if (step == TTGlobeRestore || step == TTGlobeForget) {
    BOOL existed = ![TTVoiceObject([defaults objectForKey:TTGlobeOriginal])[@"existed"] isEqual:@NO];
    if (step == TTGlobeRestore) {
      TTGlobeSet(saved.intValue);
      if (!existed) { // it was macOS's own choice: unset again, so it keeps following the keyboard and input sources
        CFPreferencesSetValue(TTGlobeKey, NULL, TTGlobeDomain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
        CFPreferencesSynchronize(TTGlobeDomain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
      }
    }
    [defaults removeObjectForKey:TTGlobeOriginal];
    CFPreferencesAppSynchronize(kCFPreferencesCurrentApplication);
    dictate_log(step == TTGlobeRestore ? [NSString stringWithFormat:@"globe key: given back (%d)", saved.intValue].UTF8String : "globe key: changed since, left as it is");
    if (want) TTGlobeSync(want, NO); // left over and chosen since: that choice is the original now
  }
}
static void TTGlobeGiveBack(void) { TTGlobeSync(NO, NO); }

// What "Press 🌐 key to" (System Settings › Keyboard) does. An action there competes with holding fn;
// unset, the system default, is left alone because fn holds work with it.
static NSString *TTVoiceGlobeKey(void) {
  if (TTGlobeSaved() && TTGlobeLoaded() && TTGlobeGet() == 0) return @""; // held at Do Nothing by Dictate itself (TTGlobeSync)
  CFStringRef domain = CFSTR("com.apple.HIToolbox");
  CFPreferencesAppSynchronize(domain); // System Settings changes it while setup is open
  id value = (__bridge_transfer id)CFPreferencesCopyAppValue(CFSTR("AppleFnUsageType"), domain);
  if (![value isKindOfClass:NSNumber.class]) return @"";
  switch ([value intValue]) { case 1: return @"inputSource"; case 2: return @"emoji"; case 3: return @"dictation"; default: return @""; }
}
// The shortcuts macOS keeps for itself (System Settings › Keyboard › Keyboard Shortcuts) that are on, as
// [key code, NSEvent modifiers]. HIToolbox comes with AppKit, so it is looked up rather than linked.
static NSArray<NSArray<NSNumber *> *> *TTVoiceSystemShortcuts(void) {
  static OSStatus (*copy)(CFArrayRef *);
  static dispatch_once_t once;
  dispatch_once(&once, ^{ copy = (OSStatus (*)(CFArrayRef *))dlsym(RTLD_DEFAULT, "CopySymbolicHotKeys"); });
  CFArrayRef keys = NULL;
  if (!copy || copy(&keys) != noErr || !keys) return @[];
  NSMutableArray *shortcuts = [NSMutableArray new];
  for (NSDictionary *key in (__bridge_transfer NSArray *)keys) {
    if (![key isKindOfClass:NSDictionary.class] || ![key[@"kHISymbolicHotKeyEnabled"] isEqual:@YES]) continue;
    NSNumber *code = key[@"kHISymbolicHotKeyCode"], *carbon = key[@"kHISymbolicHotKeyModifiers"];
    if (![code isKindOfClass:NSNumber.class] || ![carbon isKindOfClass:NSNumber.class] || code.unsignedIntValue >= 0x80) continue;
    NSUInteger from = carbon.unsignedIntegerValue; // Carbon's cmdKey, shiftKey, optionKey, controlKey
    NSUInteger modifiers = (from & 0x100 ? NSEventModifierFlagCommand : 0) | (from & 0x200 ? NSEventModifierFlagShift : 0)
      | (from & 0x800 ? NSEventModifierFlagOption : 0) | (from & 0x1000 ? NSEventModifierFlagControl : 0);
    [shortcuts addObject:@[code, @(modifiers)]];
  }
  return shortcuts;
}
bool dictate_settings_status(char *output, size_t capacity) {
  if (!output || capacity == 0) return false;
  output[0] = 0;
  AVAuthorizationStatus mic = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  NSDictionary *snapshot = @{
    @"enabled": [NSNumber numberWithBool:voice ? voice.enabled : [NSUserDefaults.standardUserDefaults boolForKey:@"DictateEnabled"]],
    @"microphone": mic == AVAuthorizationStatusAuthorized ? @"allowed" : mic == AVAuthorizationStatusNotDetermined ? @"notDetermined" : @"denied",
    @"accessibility": [NSNumber numberWithBool:AXIsProcessTrusted()], @"globeKey": TTVoiceGlobeKey(),
    @"modelReady": [NSNumber numberWithBool:voice.modelReady], @"modelPreparing": [NSNumber numberWithBool:voice.modelPreparing],
    @"modelMessage": voice.modelMessage ?: @"",
    @"inputs": TTVoiceInputs(), @"input": TTVoiceChosenInput() ?: NSNull.null, @"inputInUse": TTVoiceInputName(),
    @"openAtLogin": [NSNumber numberWithBool:dictate_open_at_login(-1)], @"systemShortcuts": TTVoiceSystemShortcuts()
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:nil];
  if (!data || data.length >= capacity) return false;
  memcpy(output, data.bytes, data.length); output[data.length] = 0;
  return true;
}
// Open at Login, through macOS's own login items (System Settings › General › Login Items). `set` is
// -1 to only read it, 0 for off, 1 for on; answers whether it is on.
bool dictate_open_at_login(int set) {
  SMAppService *service = SMAppService.mainAppService;
  NSError *error;
  if (set == 1 && service.status != SMAppServiceStatusEnabled) [service registerAndReturnError:&error];
  if (set == 0 && service.status == SMAppServiceStatusEnabled) [service unregisterAndReturnError:&error];
  return service.status == SMAppServiceStatusEnabled;
}
void dictate_set_enabled(bool enabled) { dictate_init(); [voice applyEnabled:enabled]; }
// A microphone from the dots' menu by its UID, or NULL for the Mac's own input. It applies from the
// next time the microphone opens.
void dictate_set_input(const char *uid) {
  if (uid) [NSUserDefaults.standardUserDefaults setObject:@(uid) forKey:@"DictateInput"];
  else [NSUserDefaults.standardUserDefaults removeObjectForKey:@"DictateInput"];
}
// Setup actions from the overlay page.
void dictate_request(const char *kind) {
  NSString *what = @(kind);
  if ([what isEqual:@"microphone"]) {
    if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] == AVAuthorizationStatusNotDetermined) {
      [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) { (void)granted; }];
    } else {
      [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"]];
    }
  } else if ([what isEqual:@"accessibility"]) {
    // macOS's own prompt is what puts the app in the list, and it has its own Open System Settings;
    // opening Settings too put two windows up at once. Once it has been shown, go straight there.
    static BOOL prompted;
    if (!prompted) { prompted = YES; AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES}); return; }
    [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]];
  } else if ([what isEqual:@"note"]) {
    [voice toggleNote];
  } else if ([what isEqual:@"send"]) { // the hands-free pill's buttons
    [voice sendFromOverlay];
  } else if ([what isEqual:@"cancel"]) {
    if (voice.phase != TTVoiceSubmitting) [voice cancel];
    voice.held = NO;
  } else if ([what isEqual:@"keyboard"]) {
    [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.Keyboard-Settings.extension"]];
  }
}
// ---------- Sticky windows: the sheet, and a clear gutter above it where the pill floats in ----------
// A window takes all of its mouse events or none, so a click on the clear gutter would go nowhere. As the overlay
// does, a sticky's window takes the mouse only while the pointer is over the sheet, or over the pill while it is
// up: the pill rises when the pointer comes onto the sheet and stays while the pointer is over either, with a
// moment's grace for crossing the gap; the page holds it up while its colours or menu are open. The page hears
// when it rises and falls (dictate_ui_sticky_hover), since WebKit's own hover goes stale once the window stops
// taking the mouse.
@interface TTSticky : NSObject
@property (weak) NSWindow *window;
@property (copy) NSString *name;
@property CGFloat gutter, pillWidth, pillTop; // points: the clear strip's height, the pill's width, its distance from the top
@property BOOL up, hold;
@property CFAbsoluteTime left; // when the pointer left the sheet and the pill, while the pill was up
@end
@implementation TTSticky
@end

static NSMutableArray<TTSticky *> *stickies;
static NSTimer *stickyTimer;

static void TTStickyTick(void) {
  NSPoint at = NSEvent.mouseLocation;
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  for (TTSticky *sticky in [stickies copy]) {
    NSWindow *window = sticky.window;
    if (!window) { [stickies removeObject:sticky]; continue; }
    if (!window.visible) continue;
    NSRect frame = window.frame;
    NSRect sheet = NSMakeRect(NSMinX(frame), NSMinY(frame), NSWidth(frame), NSHeight(frame) - sticky.gutter);
    // The pill, the gap under it down to the sheet, and a little around: where it is reached.
    NSRect pill = NSMakeRect(NSMidX(frame) - sticky.pillWidth / 2 - 8, NSMaxY(sheet), sticky.pillWidth + 16, sticky.gutter - sticky.pillTop + 4);
    BOOL onSheet = NSPointInRect(at, sheet), onPill = NSPointInRect(at, pill);
    BOOL near = onSheet || ((sticky.up || sticky.hold) && onPill);
    if (near) {
      sticky.left = 0;
      if (!sticky.up) { sticky.up = YES; dictate_ui_sticky_hover(sticky.name.UTF8String, true); }
    } else if (sticky.up) {
      if (!sticky.left) sticky.left = now;
      else if (now - sticky.left > 0.2) { sticky.up = NO; dictate_ui_sticky_hover(sticky.name.UTF8String, false); }
    }
    BOOL dragging = NSEvent.pressedMouseButtons != 0 && !window.ignoresMouseEvents;
    BOOL take = onSheet || ((sticky.up || sticky.hold) && onPill) || dragging;
    if (window.ignoresMouseEvents == take) { window.ignoresMouseEvents = !take; TTLookAgain(); }
  }
  if (!stickies.count) { [stickyTimer invalidate]; stickyTimer = nil; }
}

// A sticky's window to watch, with its gutter's height, its pill's width and how far the pill is from the top
// (all points). Called again when the pill's width changes. Any thread.
void dictate_sticky_watch(void *window, const char *id, double gutter, double pill_width, double pill_top) {
  if (!window || !id) return;
  NSWindow *target = (__bridge NSWindow *)window;
  NSString *name = @(id);
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!stickies) stickies = [NSMutableArray new];
    TTSticky *sticky = nil;
    for (TTSticky *one in stickies) if (one.window == target) { sticky = one; break; }
    if (!sticky) { sticky = [TTSticky new]; sticky.window = target; [stickies addObject:sticky]; }
    sticky.name = name; sticky.gutter = gutter; sticky.pillWidth = pill_width; sticky.pillTop = pill_top;
    if (!stickyTimer) {
      stickyTimer = [NSTimer timerWithTimeInterval:1.0 / 60 repeats:YES block:^(NSTimer *timer) { (void)timer; TTStickyTick(); }];
      [NSRunLoop.mainRunLoop addTimer:stickyTimer forMode:NSRunLoopCommonModes];
    }
  });
}
// The page keeps the pill up (its colours or menu are open, or the keyboard is in it), wherever the pointer is.
void dictate_sticky_hold(void *window, bool hold) {
  if (!window) return;
  NSWindow *target = (__bridge NSWindow *)window;
  dispatch_async(dispatch_get_main_queue(), ^{ for (TTSticky *one in stickies) if (one.window == target) { one.hold = hold; return; } });
}

void dictate_overlay_attach(void *window) {
  if (!window) return;
  if (!overlay) overlay = [TTVoiceOverlay new];
  [overlay attach:(__bridge NSWindow *)window];
}
void dictate_overlay_layout(const char *json) {
  if (!json || !overlay) return;
  NSDictionary *values = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil];
  if ([values isKindOfClass:NSDictionary.class]) [overlay layout:values];
}

// Dictation › Sounds' preview of a cue, at the volume being chosen.
void dictate_play_sound(const char *name, double volume) {
  if (name) TTVoicePlaySound(@(name), volume);
}
void dictate_model_status(const char *message, int status) {
  if (!voice.enabled) return;
  voice.modelReady = status == 1; voice.modelPreparing = status == 0;
  voice.modelMessage = @(message);
  if (status < 0 && voice.phase == TTVoiceIdle) dictate_ui_error(message);
}
// Whether Return follows this hold's words, decided by Rust (the app's setting or a spoken "send") just
// before the words arrive through dictate_result.
void dictate_result_sends(const char *request, bool send) {
  if (request && [voice.request isEqual:@(request)]) voice.sendAfter = send;
}
void dictate_draft_result(const char *request, const char *text) {
  if (![voice.request isEqual:@(request)] || voice.phase != TTVoiceListening) return;
  dictate_ui_said(text, voice.dictating, true); // for the overlay only: the field gets the words once, on release
}
// A note's step: what is transcribed for good can go from the buffer, and the piece still being said
// is the preview.
void dictate_note_progress(const char *request, size_t transcribed, const char *preview) {
  if (![voice.request isEqual:@(request)] || voice.phase != TTVoiceListening || !voice.noting) return;
  [voice.audio dropTo:transcribed];
  if (preview) dictate_ui_said(preview, false, true);
}
void dictate_result(const char *request, const char *text, const char *error) {
  if (![voice.request isEqual:@(request)] || voice.phase != TTVoiceFinishing) return;
  NSError *failure = error ? [NSError errorWithDomain:@"Dictate" code:1 userInfo:@{NSLocalizedDescriptionKey: @(error)}] : nil;
  [voice receiveText:text ? @(text) : @"" error:failure generation:voice.generation];
}

// ---------- Settings, typing and commands from Rust ----------

// The whole settings object, each time it changes.
void dictate_apply_settings(const char *json) {
  if (!json) return;
  id values = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil];
  if (![values isKindOfClass:NSDictionary.class]) return;
  appliedSettings = values;
  [voice apply:values];
}
// The name the person knows an app by, from its bundle id, while it runs.
bool dictate_app_name(const char *bundle_id, char *output, size_t capacity) {
  if (!bundle_id || !output || capacity == 0) return false;
  NSString *name = [NSRunningApplication runningApplicationsWithBundleIdentifier:@(bundle_id)].firstObject.localizedName;
  return name && [name getCString:output maxLength:capacity encoding:NSUTF8StringEncoding];
}
// Types `text` into the focused field of the front app, over its selection if it has one.
static void TTVoiceTypeText(NSString *text) {
  if (!text.length) return;
  if (!AXIsProcessTrusted()) {
    TTVoiceCopy(text);
    dictate_ui_error("Dictate needs Accessibility to type, so it’s on the clipboard instead. Turn it on in System Settings.");
    return;
  }
  // These keystrokes are ours, so the monitor never sees the field change: the next hold starts afresh.
  voice.dictated = nil;
  if (voice.typed.length) voice.typingStopped = YES;
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  TTInsertText(text, front.processIdentifier, front.bundleIdentifier, ^(TTInserted how) { (void)how; });
}
static void TTVoiceOnMain(dispatch_block_t work) {
  if (NSThread.isMainThread) work(); else dispatch_async(dispatch_get_main_queue(), work);
}
void dictate_type_text(const char *text) {
  if (!text) return;
  NSString *words = @(text);
  TTVoiceOnMain(^{ TTVoiceTypeText(words); });
}
static void TTVoiceCopyAnswer(NSString *text) {
  TTVoiceCopy(text);
  dictate_ui_notice("You switched apps, so the answer is on your clipboard instead.");
}
// Claude's answer to a command. `type` puts it over the selection, or at the caret, in the app the command
// was said in: a click on the overlay's card took the front, so that app comes back first, and an
// answer for an app the person has left goes to the clipboard rather than into another app. `show` is
// the overlay's card, which the page draws from dictate-command; its Insert asks for `type` later.
static void TTVoiceCommandResult(NSString *request, NSString *text, NSString *action) {
  if ([action isEqual:@"show"]) { if (overlay.shown) [overlay.window orderFrontRegardless]; return; }
  if (![action isEqual:@"type"] || !text.length) return;
  NSRunningApplication *target = TTVoiceCommandApp(request);
  if (!target || target.terminated || TTVoiceFront(target)) { TTVoiceTypeText(text); return; }
  if (!TTVoiceFront(NSRunningApplication.currentApplication)) { TTVoiceCopyAnswer(text); return; }
  TTVoiceBringForward(target, ^(BOOL front) { if (front) TTVoiceTypeText(text); else TTVoiceCopyAnswer(text); });
}
void dictate_command_result(const char *request, const char *text, const char *action) {
  if (!request || !text || !action) return;
  NSString *key = @(request), *words = @(text), *how = @(action);
  TTVoiceOnMain(^{ TTVoiceCommandResult(key, words, how); });
}

