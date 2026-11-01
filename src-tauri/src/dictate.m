#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ServiceManagement/ServiceManagement.h>

// Everything the person sees is drawn by the overlay page (the `voice` window); this file owns the
// fn key, the microphone and the overlay window's native parts (blur, click-through).
extern void dictate_ui_state(const char *phase, double level, bool dictating);
extern void dictate_ui_error(const char *message);
extern void dictate_ui_fn(bool down);
extern void dictate_ui_note(const char *text);
extern void dictate_ui_pointer(bool over, double x, double y);
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
bool dictate_open_at_login(int set);

// ---------- The read-aloud player: speech arrives in pieces as it is made, tagged with the reply ----------

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
- (double)level;
- (void)resetLevel;
- (void)append:(AVAudioPCMBuffer *)buffer;
- (NSData *)freeze;
- (NSData *)snapshot;
- (NSData *)snapshotFrom:(NSUInteger *)base;
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
    self.limit = 60 * 16000;
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
- (NSData *)snapshot { @synchronized (self) { return [self.samples copy]; } }
- (NSData *)snapshotFrom:(NSUInteger *)base { @synchronized (self) { *base = self.dropped; return [self.samples copy]; } }
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
@property BOOL enabled, held, fnDown, blocked, modelReady, modelPreparing, trusted, dictating;
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
@property (copy) NSString *typed, *lastDraft; // dictation: what this hold put at the cursor, and the newest live words
@property pid_t typedApp;
@property (strong) id typedField;
@property BOOL typingStopped; // the person clicked or typed after our words went in: never correct them again
@property (copy) NSString *replaced; // the selection this hold's first words typed over
// Everything dictation typed into one field over consecutive holds, while the person has not clicked
// or typed there since: a hold that continues it starts with a space.
@property (copy) NSString *dictated, *lead; // lead: the space a hold that continues it types first
@property pid_t dictatedApp;
@property (strong) id dictatedField;
// A note from the overlay's note button: no minute cap, transcribed while it is said, done after three
// minutes of quiet.
@property BOOL noting;
@property NSTimeInterval lastSpoke;
// The app's settings as Rust last applied them (settings.json, camelCase).
@property (copy) NSDictionary *settings;
@end

// The text field that has the keyboard focus, as Accessibility sees it.
static id TTVoiceFocusedField(void) {
  AXUIElementRef everything = AXUIElementCreateSystemWide();
  CFTypeRef field = NULL;
  AXUIElementCopyAttributeValue(everything, kAXFocusedUIElementAttribute, &field);
  CFRelease(everything);
  return (__bridge_transfer id)field;
}
static BOOL TTVoiceSameField(id one, id other) {
  return one == other || (one && other && CFEqual((__bridge CFTypeRef)one, (__bridge CFTypeRef)other));
}
// Characters as the person sees them from `from` on: one delete removes one of these.
static NSUInteger TTVoiceVisible(NSString *text, NSUInteger from) {
  __block NSUInteger count = 0;
  [text enumerateSubstringsInRange:NSMakeRange(from, text.length - from) options:NSStringEnumerationByComposedCharacterSequences | NSStringEnumerationSubstringNotRequired usingBlock:^(NSString *part, NSRange range, NSRange whole, BOOL *stop) { (void)part; (void)range; (void)whole; (void)stop; count++; }];
  return count;
}
// Marks our own keystrokes, so the fn monitor never takes them for an fn shortcut.
static const int64_t TTVoiceMark = 0x74747663;
static void TTVoicePostKey(CGKeyCode key, NSString *text) {
  CGEventRef events[] = { CGEventCreateKeyboardEvent(NULL, key, true), CGEventCreateKeyboardEvent(NULL, key, false) };
  UniChar units[32]; NSUInteger count = MIN(text.length, 32);
  if (text) [text getCharacters:units range:NSMakeRange(0, count)];
  for (int i = 0; i < 2; i++) {
    CGEventSetFlags(events[i], 0); // not the fn and control still held
    CGEventSetIntegerValueField(events[i], kCGEventSourceUserData, TTVoiceMark);
    if (text) CGEventKeyboardSetUnicodeString(events[i], count, units);
    CGEventPost(kCGAnnotatedSessionEventTap, events[i]); CFRelease(events[i]);
  }
}

// Types `text` from `from` on, a few characters per key event (one carries at most 20).
static void TTVoiceType(NSString *text, NSUInteger from) {
  for (NSUInteger at = from; at < text.length;) {
    NSRange chunk = [text rangeOfComposedCharacterSequencesForRange:NSMakeRange(at, MIN(16, text.length - at))];
    TTVoicePostKey(0, [text substringWithRange:chunk]);
    at = NSMaxRange(chunk);
  }
}
// The words two live drafts in a row agree on, cut back to a whole word, so the cursor isn't rewritten
// every time Whisper changes its mind about the word still being said.
static NSString *TTVoiceAgreed(NSString *before, NSString *now) {
  if (!before) return @"";
  NSUInteger same = 0, max = MIN(before.length, now.length);
  while (same < max && [before characterAtIndex:same] == [now characterAtIndex:same]) same++;
  BOOL edge = (same == before.length || [before characterAtIndex:same] == ' ') && (same == now.length || [now characterAtIndex:same] == ' ');
  if (edge) return [now substringToIndex:same];
  NSRange space = [now rangeOfString:@" " options:NSBackwardsSearch range:NSMakeRange(0, same)];
  return space.location == NSNotFound ? @"" : [now substringToIndex:space.location];
}

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
// The microphone voice records from: the one picked in the dots' menu while it is connected, otherwise
// the Mac's own input.
static AudioObjectID TTVoiceInput(void) {
  AudioObjectID device = kAudioObjectUnknown; UInt32 size = sizeof(device);
  CFStringRef chosen = (__bridge CFStringRef)TTVoiceChosenInput();
  AudioObjectPropertyAddress address = { kAudioHardwarePropertyTranslateUIDToDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  if (chosen && AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, sizeof(chosen), &chosen, &size, &device) == noErr && device != kAudioObjectUnknown) return device;
  address.mSelector = kAudioHardwarePropertyDefaultInputDevice; device = kAudioObjectUnknown; size = sizeof(device);
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device);
  return device;
}
static NSString *TTVoiceInputName(void) { return TTVoiceDeviceString(TTVoiceInput(), kAudioObjectPropertyName) ?: @"?"; }

static dispatch_queue_t TTVoiceAudioQueue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("com.tabtasker.voice.audio", DISPATCH_QUEUE_SERIAL); });
  return queue;
}

@implementation TTVoiceCommands
@synthesize phase = _phase;
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
  if (phase == TTVoiceListening && !self.levelTimer) {
    __weak TTVoiceCommands *weak = self;
    self.levelTimer = [NSTimer timerWithTimeInterval:1.0 / 30 repeats:YES block:^(NSTimer *timer) { (void)timer; [weak tick]; }];
    [NSRunLoop.mainRunLoop addTimer:self.levelTimer forMode:NSRunLoopCommonModes];
    // Live words: what has been said so far, transcribed again as soon as the last pass is done (a tick
    // that finds one still running skips), so typed words keep up with the speech.
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
  if (self.noting) {
    NSUInteger base = 0;
    NSData *held = [self.audio snapshotFrom:&base];
    if (held.length) dictate_note_step(self.request.UTF8String, base, held.bytes, held.length / sizeof(float));
    return;
  }
  NSData *pcm = [self.audio snapshot];
  if (pcm.length) dictate_draft(self.request.UTF8String, pcm.bytes, pcm.length / sizeof(float));
}
- (void)tick {
  double target = self.audio.level;
  self.displayLevel = target > self.displayLevel ? target : self.displayLevel * 0.82;
  if (self.displayLevel < 0.0001) self.displayLevel = 0;
  dictate_ui_state("listening", MIN(1, self.displayLevel), self.dictating);
  if (!self.noting) return;
  NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
  if (target > 0.01) self.lastSpoke = now;
  else if (now - self.lastSpoke > 180) { // a note left running: what was said is kept
    dictate_ui_notice("Stopped after 3 minutes of quiet");
    self.held = NO; [self finish];
  }
}
- (void)stopCapture {
  AVAudioEngine *engine = self.engine;
  self.engine = nil;
  if (engine) {
    [NSNotificationCenter.defaultCenter removeObserver:self name:AVAudioEngineConfigurationChangeNotification object:engine];
    dispatch_async(TTVoiceAudioQueue(), ^{ [engine stop]; @try { [engine.inputNode removeTapOnBus:0]; } @catch (NSException *e) { (void)e; } });
  }
  [self.audio resetLevel]; self.displayLevel = 0;
}
- (void)cancel {
  self.generation++;
  self.gesture++;
  [self stopCapture];
  self.audio = nil;
  if (self.request) dictate_cancel(self.request.UTF8String);
  [self settleTyped];
  self.request = nil; self.dictating = NO; self.noting = NO; self.phase = TTVoiceIdle;
}
// What this hold typed is in the field now, finished or not; unless the person moved on, the next hold
// carries on from it.
- (void)settleTyped {
  if (self.typed.length) self.dictated = self.typingStopped ? nil : [(self.dictated ?: @"") stringByAppendingString:self.typed];
  [self forgetTyped];
}
- (void)forgetTyped { self.typed = nil; self.lastDraft = nil; self.typedField = nil; self.typingStopped = NO; self.lead = @""; self.replaced = nil; }
- (void)fail:(NSString *)message {
  [self cancel];
  dictate_ui_error(message.UTF8String);
}
- (void)begin {
  if (self.phase != TTVoiceIdle || !self.enabled || !self.held || self.blocked) return;
  if (!self.modelReady) { [self fail:@"Voice is still loading"]; return; }
  self.request = NSUUID.UUID.UUIDString;
  self.generation++;
  [self forgetTyped];
  NSString *app = NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier ?: @"";
  dictate_hold_begin(self.request.UTF8String, self.noting ? "note" : "dictate", app.UTF8String);
  self.phase = TTVoiceListening;
  self.listeningSince = NSProcessInfo.processInfo.systemUptime;
  if (!self.engine) [self startCapture]; // otherwise the microphone opened when fn went down
  if (self.noting) { self.audio.limit = 10 * 60 * 16000; self.lastSpoke = self.listeningSince; return; } // only what is not yet transcribed
  NSUInteger generation = self.generation;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (self.generation == generation && self.phase == TTVoiceListening) [self fail:@"One minute max"];
  });
}
- (void)startCapture {
  if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] != AVAuthorizationStatusAuthorized) {
    [self fail:@"microphone"]; return; // the overlay shows its microphone card for this one
  }
  AVAudioEngine *engine = [AVAudioEngine new];
  self.engine = engine;
  self.audio = [TTVoiceAudio new];
  // A Bluetooth headset (AirPods) switches profile when its microphone opens: the input format
  // changes and the engine stops itself. Capture picks up again on the new format.
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(inputChanged:) name:AVAudioEngineConfigurationChangeNotification object:engine];
  self.inputChanges = 0;
  TTVoiceAudio *audio = self.audio;
  dispatch_async(TTVoiceAudioQueue(), ^{ [self tap:engine audio:audio]; });
}
// On the audio queue: tap the input as it is now and start the engine. Opening a microphone can take
// a second or more (the headset's profile switch), which must not stall the main thread.
- (void)tap:(AVAudioEngine *)engine audio:(TTVoiceAudio *)audio {
  if (self.engine != engine) return; // the hold already ended
  NSString *problem = nil;
  @try {
    AVAudioInputNode *input = engine.inputNode;
    [input removeTapOnBus:0];
    if (TTVoiceChosenInput()) { // otherwise the engine follows the Mac's input
      AudioObjectID device = TTVoiceInput();
      AudioUnitSetProperty(input.audioUnit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, sizeof(device));
    }
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (!format.channelCount || format.sampleRate <= 0) {
      problem = @"No mic found";
    } else {
      AVAudioNodeTapBlock append = ^(AVAudioPCMBuffer *buffer, AVAudioTime *when) { (void)when; [audio append:buffer]; };
      AVAudioFrameCount frames = (AVAudioFrameCount)ceil(format.sampleRate * 0.1);
      NSError *error;
      if (@available(macOS 27.0, *)) {
        if (![input installTapOnBus:0 bufferSize:frames format:nil error:&error block:append]) problem = @"Couldn’t start the mic";
      } else { [input installTapOnBus:0 bufferSize:frames format:nil block:append]; }
      if (!problem) {
        [engine prepare];
        if (![engine startAndReturnError:&error]) problem = @"Couldn’t start the mic";
      }
    }
  } @catch (NSException *exception) {
    (void)exception;
    problem = @"Mic changed, try again";
  }
  if (self.engine != engine) { [engine stop]; return; } // ended while the microphone was opening
  if (problem) dispatch_async(dispatch_get_main_queue(), ^{
    if (self.engine != engine) return;
    if (self.phase == TTVoiceListening) [self fail:problem];
    else { [self stopCapture]; self.audio = nil; } // the hold hasn't begun: begin opens it again and says what's wrong
  });
}
- (void)inputChanged:(NSNotification *)note {
  AVAudioEngine *engine = note.object;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (engine != self.engine) return; // a capture that ended has no engine
    self.inputChanges++;
    TTVoiceAudio *audio = self.audio;
    // Mid-switch the device can report no format for a moment.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), TTVoiceAudioQueue(), ^{ [self tap:engine audio:audio]; });
  });
}
- (void)transcribe {
  BOOL running = self.engine.isRunning;
  NSData *pcm = [self.audio freeze];
  AVAudioFormat *heard = self.audio.heard;
  NSString *line = [NSString stringWithFormat:@"capture: %.1fs held, %lu buffers, %.0f Hz x%u%@, %lu samples, loudest %.4f, %lu input changes, engine %@, input %@",
    NSProcessInfo.processInfo.systemUptime - self.listeningSince, (unsigned long)self.audio.buffers, heard.sampleRate, heard.channelCount, self.audio.channelLevels,
    (unsigned long)(pcm.length / sizeof(float)), self.audio.peak, (unsigned long)self.inputChanges, running ? @"running" : @"stopped", TTVoiceInputName()];
  dictate_log(line.UTF8String);
  if (self.audio.failed) { [self fail:@"Couldn’t record that"]; return; }
  if (self.noting) { // the rest of the note: most of it is in its words already
    if (!dictate_note_finish(self.request.UTF8String, self.audio.dropped, pcm.bytes, pcm.length / sizeof(float))) [self fail:@"Voice is still loading"];
    self.audio = nil; return;
  }
  if (!pcm.length) {
    // A short hold ends before the first audio arrives (a Bluetooth microphone takes a moment to open).
    BOOL tap = NSProcessInfo.processInfo.systemUptime - self.listeningSince < 1.5;
    [self fail:tap ? @"unheard" : @"No sound from the mic"]; return;
  }
  if (!dictate_audio(self.request.UTF8String, pcm.bytes, pcm.length / sizeof(float))) {
    [self fail:@"Voice is still loading"];
  }
  self.audio = nil;
}
- (void)finish {
  if (self.phase != TTVoiceListening) return;
  self.phase = TTVoiceFinishing;
  [self stopCapture];
  NSUInteger generation = self.generation;
  [self transcribe];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (self.generation == generation && self.phase == TTVoiceFinishing) [self fail:@"Took too long, try again"];
  });
}
- (void)receiveText:(NSString *)text error:(NSError *)error generation:(NSUInteger)generation {
  if (self.generation != generation || self.phase != TTVoiceFinishing) return;
  if (error) { [self fail:error.localizedDescription ?: @"Couldn’t understand that"]; return; }
  NSString *body = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (!body.length) { [self fail:@"unheard"]; return; } // the overlay's "Didn't catch that"
  if (self.noting) { dictate_ui_note(body.UTF8String); [self cancel]; return; } // to the note's review card
  dictate_ui_said(body.UTF8String, true, false);
  if (!AXIsProcessTrusted()) { [self fail:@"Turn on Accessibility to type"]; return; }
  [self retype:body]; [self cancel];
}
// Dictation: brings what this hold typed at the cursor to `text`, deleting back to where they differ
// and typing the rest, as keystrokes into whatever has the keyboard focus.
- (void)retype:(NSString *)text {
  if (self.typingStopped) return;
  pid_t app = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  id field = TTVoiceFocusedField();
  if (!self.typed.length) {
    self.typedApp = app; self.typedField = field;
    CFTypeRef selected = NULL;
    if (field && AXUIElementCopyAttributeValue((__bridge AXUIElementRef)field, kAXSelectedTextAttribute, &selected) == kAXErrorSuccess) {
      id value = (__bridge_transfer id)selected;
      self.replaced = [value isKindOfClass:NSString.class] ? value : nil;
    }
    BOOL continues = self.dictated.length && app == self.dictatedApp && TTVoiceSameField(field, self.dictatedField);
    if (!continues) { self.dictated = nil; self.dictatedApp = app; self.dictatedField = field; }
    BOOL spaced = !continues || [NSCharacterSet.whitespaceAndNewlineCharacterSet characterIsMember:[self.dictated characterAtIndex:self.dictated.length - 1]];
    self.lead = spaced ? @"" : @" ";
  } else if (app != self.typedApp || !TTVoiceSameField(field, self.typedField)) {
    self.typingStopped = YES; return; // focus moved on: never delete anywhere but where our words went
  }
  text = [self.lead stringByAppendingString:text];
  NSString *typed = self.typed ?: @"";
  NSUInteger same = 0, max = MIN(typed.length, text.length);
  while (same < max && [typed characterAtIndex:same] == [text characterAtIndex:same]) same++;
  // Back to a character boundary in both: marks added to the last letter retype the letter too.
  for (NSUInteger was = NSNotFound; was != same;) {
    was = same;
    if (same < text.length) same = [text rangeOfComposedCharacterSequenceAtIndex:same].location;
    if (same < typed.length) same = [typed rangeOfComposedCharacterSequenceAtIndex:same].location;
  }
  for (NSUInteger i = TTVoiceVisible(typed, same); i > 0; i--) TTVoicePostKey(51, nil);
  TTVoiceType(text, same);
  self.typed = text;
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
- (void)handleEvent:(NSEvent *)event {
  CGEventRef raw = event.CGEvent;
  if (event.type == NSEventTypeKeyDown && raw && (CGEventGetIntegerValueField(raw, kCGEventSourceUserData) == TTVoiceMark || CGEventGetIntegerValueField(raw, kCGEventSourceUnixProcessID) == getpid())) return;
  // Any click or key of the person's own after our words went in can move the caret.
  if (event.type != NSEventTypeFlagsChanged) { if (self.typed.length) self.typingStopped = YES; self.dictated = nil; }
  if (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeRightMouseDown) return;
  // fn always reaches the overlay, so its setup can test the key before voice is on.
  if (event.type == NSEventTypeFlagsChanged && event.keyCode == 63) {
    BOOL down = (event.modifierFlags & NSEventModifierFlagFunction) != 0;
    if (down != self.fnDown) { self.fnDown = down; dictate_ui_fn(down); }
  }
  if (!self.enabled) return;
  if (event.type == NSEventTypeKeyDown) {
    if (event.keyCode == 53) { self.blocked = YES; if (self.phase != TTVoiceSubmitting) [self cancel]; }
    else if (self.held && self.phase != TTVoiceSubmitting) { self.blocked = YES; [self cancel]; } // fn+key is a shortcut
    return;
  }
  if (event.type != NSEventTypeFlagsChanged) return;
  // fn alone types where the cursor is; fn with a modifier is a shortcut.
  NSEventModifierFlags other = event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagOption | NSEventModifierFlagShift | NSEventModifierFlagControl);
  if (other && self.held && self.phase != TTVoiceSubmitting) { self.blocked = YES; [self cancel]; }
  if (event.keyCode != 63) return;
  BOOL held = (event.modifierFlags & NSEventModifierFlagFunction) != 0;
  if (held == self.held) return;
  self.held = held;
  NSUInteger gesture = ++self.gesture;
  if (!held) {
    self.blocked = NO;
    if (self.phase == TTVoiceIdle) { [self stopCapture]; self.audio = nil; } // a tap: the hold never began
    [self finish]; return;
  }
  self.blocked = other != 0;
  if (self.phase == TTVoiceIdle) self.dictating = YES;
  // The microphone opens now rather than when the hold begins, so the first words are not cut off; a
  // tap or an fn shortcut closes it unheard.
  if (self.phase == TTVoiceIdle && !self.blocked && self.modelReady && !self.engine
      && [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] == AVAuthorizationStatusAuthorized) [self startCapture];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 180 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    if (self.gesture == gesture) [self begin];
  });
}
- (void)monitor {
  if (self.localMonitor) [NSEvent removeMonitor:self.localMonitor];
  if (self.globalMonitor) [NSEvent removeMonitor:self.globalMonitor];
  self.trusted = AXIsProcessTrusted();
  __weak TTVoiceCommands *weak = self;
  NSEventMask mask = self.enabled ? NSEventMaskFlagsChanged | NSEventMaskKeyDown | NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown : NSEventMaskFlagsChanged;
  self.localMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
    BOOL cancel = event.type == NSEventTypeKeyDown && event.keyCode == 53 && weak.phase != TTVoiceIdle;
    [weak handleEvent:event]; return cancel ? nil : event;
  }];
  self.globalMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent *event) { [weak handleEvent:event]; }];
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
  self.modelMessage = @"Preparing Whisper large-v3 Turbo…";
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
  [self monitor];
  if (self.enabled) [self prepareModels];
  else {
    self.modelReady = NO; self.modelPreparing = NO; self.modelMessage = @"Voice is off. Your local model is kept for next time.";
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
- (void)fitScreen {
  NSScreen *screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
  if (screen) [self.window setFrame:screen.visibleFrame display:YES];
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
  NSPoint point = [web convertPoint:[window convertPointFromScreen:NSEvent.mouseLocation] fromView:nil];
  BOOL over = NO;
  for (NSValue *hit in self.hits) if (NSPointInRect(point, hit.rectValue)) { over = YES; break; }
  BOOL dragging = NSEvent.pressedMouseButtons != 0 && !window.ignoresMouseEvents;
  BOOL ignore = !(over || dragging);
  if (window.ignoresMouseEvents != ignore) {
    window.ignoresMouseEvents = ignore;
    // macOS re-checks which window is under the pointer only when the mouse moves, so a trackpad
    // scroll that starts with the pointer at rest would still go to the window below. A move to
    // where the pointer already is makes it look again. (Posting needs Accessibility, which fn has.)
    if (AXIsProcessTrusted()) {
      CGEventRef here = CGEventCreate(NULL);
      CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, CGEventGetLocation(here), kCGMouseButtonLeft);
      CGEventPost(kCGHIDEventTap, move);
      CFRelease(move); CFRelease(here);
    }
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
- (void)hide {
  self.shown = NO;
  self.hits = @[];
  for (NSView *view in self.glass) view.hidden = YES;
  self.window.ignoresMouseEvents = YES;
  [self.window orderOut:nil];
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

// ---------- C API (voice_commands.rs) ----------

static TTVoiceCommands *voice;
static TTVoiceOverlay *overlay;

static NSDictionary *appliedSettings; // settings that arrived before the voice object

void dictate_init(void) {
  if (voice) return;
  voice = [TTVoiceCommands new];
  voice.settings = appliedSettings;
  voice.enabled = [NSUserDefaults.standardUserDefaults boolForKey:@"DictateEnabled"];
  [voice monitor];
  [voice watchTrust];
  if (voice.enabled) [voice prepareModels];
  [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceWillSleepNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { (void)note; [voice cancel]; voice.held = NO; }];
  [NSDistributedNotificationCenter.defaultCenter addObserverForName:@"com.apple.screenIsLocked" object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { (void)note; [voice cancel]; voice.held = NO; }];
}
// What "Press 🌐 key to" (System Settings › Keyboard) does. An action there competes with holding fn;
// unset, the system default, is left alone because fn holds work with it.
static NSString *TTVoiceGlobeKey(void) {
  CFStringRef domain = CFSTR("com.apple.HIToolbox");
  CFPreferencesAppSynchronize(domain); // System Settings changes it while setup is open
  id value = (__bridge_transfer id)CFPreferencesCopyAppValue(CFSTR("AppleFnUsageType"), domain);
  if (![value isKindOfClass:NSNumber.class]) return @"";
  switch ([value intValue]) { case 1: return @"inputSource"; case 2: return @"emoji"; case 3: return @"dictation"; default: return @""; }
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
    @"openAtLogin": [NSNumber numberWithBool:dictate_open_at_login(-1)]
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
void dictate_invalidate(void) { [voice cancel]; }
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
  } else if ([what isEqual:@"keyboard"]) {
    [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.Keyboard-Settings.extension"]];
  }
}
void dictate_overlay_attach(void *window) {
  if (!window) return;
  if (!overlay) overlay = [TTVoiceOverlay new];
  [overlay attach:(__bridge NSWindow *)window];
}
void dictate_overlay_hide(void) { [overlay hide]; }
void dictate_overlay_layout(const char *json) {
  if (!json || !overlay) return;
  NSDictionary *values = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil];
  if ([values isKindOfClass:NSDictionary.class]) [overlay layout:values];
}

void dictate_model_status(const char *message, int status) {
  if (!voice.enabled) return;
  voice.modelReady = status == 1; voice.modelPreparing = status == 0;
  voice.modelMessage = @(message);
  if (status < 0 && voice.phase == TTVoiceIdle) dictate_ui_error(message);
}
void dictate_draft_result(const char *request, const char *text) {
  if (![voice.request isEqual:@(request)] || voice.phase != TTVoiceListening) return;
  dictate_ui_said(text, voice.dictating, true);
  if (!voice.dictating || !AXIsProcessTrusted()) return;
  NSString *now = @(text), *agreed = TTVoiceAgreed(voice.lastDraft, now);
  voice.lastDraft = now;
  if (agreed.length && ![voice.typed hasPrefix:[voice.lead stringByAppendingString:agreed]]) [voice retype:agreed];
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
  voice.settings = values;
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
  if (!AXIsProcessTrusted()) { dictate_ui_error("Turn on Accessibility to type"); return; }
  // These keystrokes are ours, so the monitor never sees the field change: the next hold starts afresh.
  voice.dictated = nil;
  if (voice.typed.length) voice.typingStopped = YES;
  TTVoiceType(text, 0);
}
static void TTVoiceOnMain(dispatch_block_t work) {
  if (NSThread.isMainThread) work(); else dispatch_async(dispatch_get_main_queue(), work);
}
void dictate_type_text(const char *text) {
  if (!text) return;
  NSString *words = @(text);
  TTVoiceOnMain(^{ TTVoiceTypeText(words); });
}
// Claude's answer to a command: `type` puts it at the caret (over the selection); `show` is the
// overlay's card, which the page draws from the dictate-command event.
void dictate_command_result(const char *request, const char *text, const char *action) {
  if (!request || !text || !action || strcmp(action, "type") != 0) return;
  NSString *words = @(text);
  TTVoiceOnMain(^{ TTVoiceTypeText(words); });
}

