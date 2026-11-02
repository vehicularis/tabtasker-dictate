#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <dlfcn.h>
#include <mach/mach_time.h>

// Meetings: the microphone and the Mac's own sound, recorded together. Each arrives in its hardware's
// rate and channels and leaves as 16 kHz mono for meeting.rs, which spools and transcribes it.

// 1 when the meeting should record the Mac's sound too, 0 for the microphone only, -1 when it can't start.
extern int dictate_meeting_begin(const char *stamp);
// `age` is how many seconds ago the first sample was captured.
extern void dictate_meeting_audio(int source, const float *samples, size_t count, double age);
// What the Mac's own sound is doing: on, off, unsupported, denied or failed.
extern void dictate_meeting_sources(const char *system);
// The moment a meeting is told to stop, before its devices close.
extern void dictate_meeting_stopping(void);
// A meeting asked for while the last one closed couldn't start: meeting.rs says why.
extern void dictate_meeting_unstarted(void);
// Called once every buffer is in; `problem` is why the meeting stopped early, or NULL.
extern void dictate_meeting_end(const char *problem);
extern void dictate_ui_error(const char *message);
extern void dictate_log(const char *line);

enum { TTMeetingMic = 0, TTMeetingSystem = 1 };

// Opening and closing devices, which can take a second (a headset switching profile).
static dispatch_queue_t TTMeetingControl(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("com.tabtasker.meeting.control", DISPATCH_QUEUE_SERIAL); });
  return queue;
}
// Resampling and the hand-off to meeting.rs, in arrival order.
static dispatch_queue_t TTMeetingAudio(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("com.tabtasker.meeting.audio", DISPATCH_QUEUE_SERIAL); });
  return queue;
}
// The tap's IO block runs here while the IO thread waits for it, so it only copies.
static dispatch_queue_t TTMeetingIO(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("com.tabtasker.meeting.io", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0)); });
  return queue;
}

// ---------- mono, then 16 kHz ----------

static double TTMeetingAge(uint64_t host) {
  uint64_t now = mach_absolute_time();
  return now > host ? [AVAudioTime secondsForHostTime:now - host] : 0;
}

// `channels` point at each channel's first sample, `stride` floats apart. The voice-processed
// microphone can report its whole array's channel count: its voice is the first channel, so that is
// what it takes unless the first is silent and another is not. Anything else is averaged.
static NSData *TTMeetingMono(const float *const *channels, UInt32 count, UInt32 stride, UInt32 frames, BOOL first) {
  if (!count || !frames) return nil;
  NSMutableData *mono = [NSMutableData dataWithLength:frames * sizeof(float)];
  float *out = mono.mutableBytes;
  if (first) {
    UInt32 pick = 0;
    double loudest = -1;
    for (UInt32 c = 0; c < count; c++) {
      double energy = 0;
      for (UInt32 i = 0; i < frames; i++) { float v = channels[c][i * stride]; energy += v * v; }
      if (c == 0 && energy > 0) break;
      if (energy > loudest) { loudest = energy; pick = c; }
    }
    for (UInt32 i = 0; i < frames; i++) out[i] = channels[pick][i * stride];
  } else {
    for (UInt32 c = 0; c < count; c++) for (UInt32 i = 0; i < frames; i++) out[i] += channels[c][i * stride] / count;
  }
  return mono;
}

static NSData *TTMeetingMonoBuffer(AVAudioPCMBuffer *buffer) {
  UInt32 count = buffer.format.channelCount;
  if (!buffer.floatChannelData || !count || count > 64) return nil;
  const float *channels[64];
  for (UInt32 c = 0; c < count; c++) channels[c] = buffer.format.isInterleaved ? buffer.floatChannelData[0] + c : buffer.floatChannelData[c];
  return TTMeetingMono(channels, count, (UInt32)buffer.stride, buffer.frameLength, YES);
}

static NSData *TTMeetingMonoList(const AudioBufferList *list, AudioStreamBasicDescription format) {
  BOOL interleaved = !(format.mFormatFlags & kAudioFormatFlagIsNonInterleaved);
  UInt32 count = format.mChannelsPerFrame, buffers = interleaved ? 1 : count;
  if (!list || !count || count > 64 || list->mNumberBuffers < buffers) return nil;
  // An output device with a microphone of its own adds that input to the aggregate's: the tap's
  // stream comes last.
  const AudioBuffer *tap = &list->mBuffers[list->mNumberBuffers - buffers];
  UInt32 frames = tap[0].mDataByteSize / (UInt32)(sizeof(float) * (interleaved ? count : 1));
  const float *channels[64];
  for (UInt32 c = 0; c < count; c++) {
    const AudioBuffer *one = &tap[interleaved ? 0 : c];
    if (!one->mData || one->mDataByteSize < frames * sizeof(float) * (interleaved ? count : 1)) return nil;
    channels[c] = (const float *)one->mData + (interleaved ? c : 0);
  }
  return TTMeetingMono(channels, count, interleaved ? count : 1, frames, NO);
}

// One source on its way to meeting.rs: mono at the hardware's rate in, 16 kHz out. Used on the audio
// queue only.
@interface TTMeetingStream : NSObject
- (instancetype)initWithSource:(int)source;
- (void)append:(NSData *)mono rate:(double)rate host:(uint64_t)host;
@end
@implementation TTMeetingStream {
  int _source;
  AVAudioFormat *_target;
  AVAudioConverter *_converter;
}
- (instancetype)initWithSource:(int)source {
  if ((self = [super init])) {
    _source = source;
    _target = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:16000 channels:1 interleaved:NO];
  }
  return self;
}
// `host` is when the first frame was captured, in host time.
- (void)append:(NSData *)mono rate:(double)rate host:(uint64_t)host {
  AVAudioFrameCount frames = (AVAudioFrameCount)(mono.length / sizeof(float));
  if (!frames || rate <= 0) return;
  if (rate == 16000) { dictate_meeting_audio(_source, mono.bytes, frames, TTMeetingAge(host)); return; }
  // A device can change rate mid-meeting (a headset's microphone opening): a new converter follows it.
  if (_converter.inputFormat.sampleRate != rate) {
    AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:rate channels:1 interleaved:NO];
    _converter = [[AVAudioConverter alloc] initFromFormat:format toFormat:_target];
    if (!_converter) return;
  }
  AVAudioPCMBuffer *input = [[AVAudioPCMBuffer alloc] initWithPCMFormat:_converter.inputFormat frameCapacity:frames];
  input.frameLength = frames;
  memcpy(input.floatChannelData[0], mono.bytes, frames * sizeof(float));
  AVAudioPCMBuffer *output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:_target frameCapacity:(AVAudioFrameCount)ceil(frames * 16000.0 / rate) + 32];
  __block BOOL supplied = NO;
  NSError *error;
  AVAudioConverterOutputStatus status = [_converter convertToBuffer:output error:&error withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount count, AVAudioConverterInputStatus *inputStatus) {
    (void)count;
    *inputStatus = supplied ? AVAudioConverterInputStatus_NoDataNow : AVAudioConverterInputStatus_HaveData;
    if (supplied) return nil;
    supplied = YES; return input;
  }];
  if (status == AVAudioConverterOutputStatus_Error || error) { _converter = nil; return; }
  if (output.frameLength) dictate_meeting_audio(_source, output.floatChannelData[0], output.frameLength, TTMeetingAge(host));
}
@end

// ---------- System Audio Recording ----------

// macOS has no public call to check or ask for System Audio Recording. TCC's own preflight and request,
// looked up at run time, let a meeting say up front that it records the mic only; without them the tap
// still asks the first time it starts.
static void *TTMeetingTCC(const char *symbol) {
  static void *tcc;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_LAZY); });
  return tcc ? dlsym(tcc, symbol) : NULL;
}
#define TTMeetingService CFSTR("kTCCServiceAudioCapture")
// 1 allowed, 2 denied, 0 not asked yet or not known.
static int TTMeetingAudioPermission(void) {
  int (*preflight)(CFStringRef, CFDictionaryRef) = (int (*)(CFStringRef, CFDictionaryRef))TTMeetingTCC("TCCAccessPreflight");
  if (!preflight) return 0;
  int result = preflight(TTMeetingService, NULL);
  return result == 0 ? 1 : result == 1 ? 2 : 0;
}
// For Settings: -1 when this macOS has no process taps, otherwise as above.
int dictate_meeting_permission(void) {
  if (@available(macOS 14.2, *)) return TTMeetingAudioPermission();
  return -1;
}

static AudioObjectID TTMeetingDefaultOutput(void) {
  AudioObjectID device = kAudioObjectUnknown; UInt32 size = sizeof(device);
  AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device);
  return device;
}
static NSString *TTMeetingDeviceUID(AudioObjectID device) {
  if (device == kAudioObjectUnknown) return nil;
  AudioObjectPropertyAddress address = { kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  CFStringRef uid = NULL; UInt32 size = sizeof(uid);
  if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &uid) != noErr || !uid) return nil;
  return (__bridge_transfer NSString *)uid;
}
static double TTMeetingRate(AudioObjectID device) {
  Float64 rate = 0; UInt32 size = sizeof(rate);
  AudioObjectPropertyAddress address = { kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  return AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &rate) == noErr ? rate : 0;
}

// ---------- the recorder ----------

@interface TTMeetingRecorder : NSObject
@property (strong) AVAudioEngine *engine;
@property (strong) TTMeetingStream *mic, *system;
@property (atomic) BOOL stopped;
- (void)start:(BOOL)system;
- (void)stop:(NSString *)problem;
@end

static TTMeetingRecorder *recorder;
// A stopped meeting is closing until meeting.rs has its last buffer; one asked for meanwhile starts
// right after. Main thread only.
static BOOL closing, startWhenClosed;
static bool TTMeetingStart(void);

static void TTMeetingStop(NSString *problem) {
  TTMeetingRecorder *stopping = recorder;
  recorder = nil;
  closing = YES;
  dictate_meeting_stopping();
  [stopping stop:problem];
}

static void TTMeetingClosed(void) {
  closing = NO;
  if (!startWhenClosed) return;
  startWhenClosed = NO;
  if (!TTMeetingStart()) dictate_meeting_unstarted();
}

@implementation TTMeetingRecorder {
  AudioObjectID _tap, _aggregate;
  AudioDeviceIOProcID _proc;
  AudioObjectPropertyListenerBlock _outputChanged;
}
- (instancetype)init {
  if ((self = [super init])) {
    _mic = [[TTMeetingStream alloc] initWithSource:TTMeetingMic];
    _system = [[TTMeetingStream alloc] initWithSource:TTMeetingSystem];
  }
  return self;
}
// On the main thread.
- (void)fail:(NSString *)problem {
  if (recorder == self) TTMeetingStop(problem);
}
- (void)start:(BOOL)system {
  dispatch_async(TTMeetingControl(), ^{
    if (self.stopped) return;
    NSString *problem = [self openMic];
    if (problem) dispatch_async(dispatch_get_main_queue(), ^{ [self fail:problem]; });
  });
  if (!system) { dictate_meeting_sources("off"); return; }
  if (@available(macOS 14.2, *)) {
    int permission = TTMeetingAudioPermission();
    if (permission == 2) { dictate_meeting_sources("denied"); return; }
    typedef void (*Request)(CFStringRef, CFDictionaryRef, void (^)(BOOL));
    Request request = permission == 0 ? (Request)TTMeetingTCC("TCCAccessRequest") : NULL;
    if (!request) { [self openSystemSoon]; return; }
    // Asked only now, as the first meeting that wants it starts; the microphone records meanwhile.
    request(TTMeetingService, NULL, ^(BOOL granted) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self.stopped) return;
        if (granted) [self openSystemSoon]; else dictate_meeting_sources("denied");
      });
    });
  } else {
    dictate_meeting_sources("unsupported");
  }
}

// ---------- the microphone: its own engine, with echo cancellation ----------

- (NSString *)openMic {
  AVAudioEngine *engine = [AVAudioEngine new];
  BOOL cancelling = NO;
  @try {
    AVAudioInputNode *input = engine.inputNode;
    NSError *error;
    // Echo cancellation takes what the speakers play out of the microphone, so without headphones the
    // other side of a call is not heard twice.
    if (![input setVoiceProcessingEnabled:YES error:&error]) dictate_log([NSString stringWithFormat:@"meeting: the microphone has no echo cancellation: %@", error.localizedDescription ?: @"no reason given"].UTF8String);
    else {
      cancelling = YES;
      if (@available(macOS 14.0, *)) {
        // Voice processing turns other audio down, which would quiet the call itself.
        AVAudioVoiceProcessingOtherAudioDuckingConfiguration ducking = { .enableAdvancedDucking = NO, .duckingLevel = AVAudioVoiceProcessingOtherAudioDuckingLevelMin };
        input.voiceProcessingOtherAudioDuckingConfiguration = ducking;
      }
    }
    (void)engine.mainMixerNode; // voice processing runs the output side too, which needs its chain
  } @catch (NSException *exception) {
    dictate_log([NSString stringWithFormat:@"meeting: the microphone engine could not be made: %@", exception.reason ?: exception.name].UTF8String);
    return @"Couldn’t start the mic";
  }
  self.engine = engine;
  // A headset switching profile or a new default device stops the engine: it picks up again.
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(micChanged:) name:AVAudioEngineConfigurationChangeNotification object:engine];
  NSString *problem = [self tapMic:engine];
  // Echo cancellation runs the speakers' side too, and on some Macs that side will not start (a display's
  // speakers, a device mid-switch, a system that refuses voice processing): the microphone plain, then,
  // which still records everything, with the other side of a call possibly heard twice.
  if (problem && cancelling) {
    dictate_log([NSString stringWithFormat:@"meeting: %@ with echo cancellation; trying the microphone plain", problem].UTF8String);
    [engine stop];
    NSError *error;
    if ([engine.inputNode setVoiceProcessingEnabled:NO error:&error]) problem = [self tapMic:engine];
    else dictate_log([NSString stringWithFormat:@"meeting: echo cancellation would not turn off: %@", error.localizedDescription ?: @"no reason given"].UTF8String);
  }
  return problem;
}
// On the control queue.
- (NSString *)tapMic:(AVAudioEngine *)engine {
  @try {
    AVAudioInputNode *input = engine.inputNode;
    [input removeTapOnBus:0];
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (!format.channelCount || format.sampleRate <= 0) {
      dictate_log([NSString stringWithFormat:@"meeting: the microphone reports no usable format (%u channels at %.0f Hz)", (unsigned)format.channelCount, format.sampleRate].UTF8String);
      return @"No mic found";
    }
    TTMeetingStream *mic = self.mic;
    dispatch_queue_t audio = TTMeetingAudio();
    AVAudioNodeTapBlock append = ^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
      uint64_t host = when.hostTimeValid ? when.hostTime : mach_absolute_time();
      NSData *mono = TTMeetingMonoBuffer(buffer);
      double rate = buffer.format.sampleRate;
      if (mono) dispatch_async(audio, ^{ [mic append:mono rate:rate host:host]; });
    };
    AVAudioFrameCount frames = (AVAudioFrameCount)ceil(format.sampleRate * 0.1);
    NSError *error;
#if defined(__MAC_27_0)
    if (@available(macOS 27.0, *)) {
      if (![input installTapOnBus:0 bufferSize:frames format:nil error:&error block:append]) {
        dictate_log([NSString stringWithFormat:@"meeting: the microphone tap would not install: %@", error.localizedDescription ?: @"no reason given"].UTF8String);
        return @"Couldn’t start the mic";
      }
    } else { [input installTapOnBus:0 bufferSize:frames format:nil block:append]; }
#else // built with an SDK before macOS 27, which has no error-returning tap
    [input installTapOnBus:0 bufferSize:frames format:nil block:append];
#endif
    [engine prepare];
    if (!engine.isRunning && ![engine startAndReturnError:&error]) {
      dictate_log([NSString stringWithFormat:@"meeting: the microphone engine would not start: %@", error.localizedDescription ?: @"no reason given"].UTF8String);
      return @"Couldn’t start the mic";
    }
  } @catch (NSException *exception) {
    dictate_log([NSString stringWithFormat:@"meeting: the microphone threw: %@", exception.reason ?: exception.name].UTF8String);
    return @"Couldn’t start the mic";
  }
  return nil;
}
- (void)micChanged:(NSNotification *)note {
  AVAudioEngine *engine = note.object;
  // Mid-switch the device can report no format for a moment.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), TTMeetingControl(), ^{
    if (self.stopped || engine != self.engine) return;
    NSString *problem = [self tapMic:engine];
    if (problem) dispatch_async(dispatch_get_main_queue(), ^{ [self fail:problem]; });
  });
}

// ---------- the Mac's own sound: a process tap in a private aggregate device ----------

- (void)openSystemSoon API_AVAILABLE(macos(14.2)) {
  dispatch_async(TTMeetingControl(), ^{
    if (self.stopped) return;
    NSString *state = [self openSystem];
    dictate_meeting_sources(state.UTF8String);
    if (![state isEqual:@"on"] || self->_outputChanged) return;
    // The aggregate keeps time with the output device: a new one (headphones in) needs a new tap.
    __weak TTMeetingRecorder *weak = self;
    self->_outputChanged = ^(UInt32 count, const AudioObjectPropertyAddress *addresses) {
      (void)count; (void)addresses;
      TTMeetingRecorder *strong = weak;
      if (!strong || strong.stopped) return;
      [strong closeSystem];
      dictate_meeting_sources([strong openSystem].UTF8String);
    };
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &address, TTMeetingControl(), self->_outputChanged);
  });
}
// On the control queue: "on", or "failed" with nothing left open.
- (NSString *)openSystem API_AVAILABLE(macos(14.2)) {
  // Everything the Mac plays except this app's own sounds.
  AudioObjectID me = kAudioObjectUnknown; UInt32 size = sizeof(me);
  pid_t pid = getpid();
  AudioObjectPropertyAddress translate = { kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  AudioObjectGetPropertyData(kAudioObjectSystemObject, &translate, sizeof(pid), &pid, &size, &me);
  CATapDescription *description = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:me == kAudioObjectUnknown ? @[] : @[@(me)]];
  description.name = @"TabTasker Dictate meeting";
  description.privateTap = YES;
  description.muteBehavior = CATapUnmuted;
  OSStatus status = AudioHardwareCreateProcessTap(description, &_tap);
  if (status != noErr) { _tap = kAudioObjectUnknown; return [self systemFailed:"create the tap" status:status]; }

  AudioStreamBasicDescription format = {0}; size = sizeof(format);
  AudioObjectPropertyAddress address = { kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  status = AudioObjectGetPropertyData(_tap, &address, 0, NULL, &size, &format);
  if (status != noErr || format.mFormatID != kAudioFormatLinearPCM || !(format.mFormatFlags & kAudioFormatFlagIsFloat) || format.mBitsPerChannel != 32) {
    return [self systemFailed:"read the tap format" status:status];
  }

  NSMutableDictionary *aggregate = [@{
    @kAudioAggregateDeviceNameKey: @"TabTasker Dictate meeting",
    @kAudioAggregateDeviceUIDKey: NSUUID.UUID.UUIDString,
    @kAudioAggregateDeviceIsPrivateKey: @YES,
    @kAudioAggregateDeviceIsStackedKey: @NO,
    @kAudioAggregateDeviceTapListKey: @[@{ @kAudioSubTapUIDKey: description.UUID.UUIDString, @kAudioSubTapDriftCompensationKey: @YES }],
  } mutableCopy];
  NSString *output = TTMeetingDeviceUID(TTMeetingDefaultOutput());
  if (output) {
    aggregate[@kAudioAggregateDeviceMainSubDeviceKey] = output;
    aggregate[@kAudioAggregateDeviceSubDeviceListKey] = @[@{ @kAudioSubDeviceUIDKey: output }];
  }
  status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate, &_aggregate);
  if (status != noErr) { _aggregate = kAudioObjectUnknown; return [self systemFailed:"create the aggregate device" status:status]; }

  double rate = TTMeetingRate(_aggregate) ?: format.mSampleRate;
  TTMeetingStream *stream = self.system;
  dispatch_queue_t audio = TTMeetingAudio();
  status = AudioDeviceCreateIOProcIDWithBlock(&_proc, _aggregate, TTMeetingIO(), ^(const AudioTimeStamp *now, const AudioBufferList *input, const AudioTimeStamp *inputTime, AudioBufferList *outputData, const AudioTimeStamp *outputTime) {
    (void)now; (void)outputData; (void)outputTime;
    uint64_t host = inputTime && (inputTime->mFlags & kAudioTimeStampHostTimeValid) ? inputTime->mHostTime : mach_absolute_time();
    NSData *mono = TTMeetingMonoList(input, format);
    if (mono) dispatch_async(audio, ^{ [stream append:mono rate:rate host:host]; });
  });
  if (status != noErr) { _proc = NULL; return [self systemFailed:"add the IO block" status:status]; }
  status = AudioDeviceStart(_aggregate, _proc);
  if (status != noErr) return [self systemFailed:"start the device" status:status];
  return @"on";
}
- (NSString *)systemFailed:(const char *)step status:(OSStatus)status API_AVAILABLE(macos(14.2)) {
  dictate_log([NSString stringWithFormat:@"meeting: couldn’t %s for the Mac’s sound (%d)", step, (int)status].UTF8String);
  [self closeSystem];
  return @"failed";
}
// On the control queue.
- (void)closeSystem {
  if (_aggregate && _proc) { AudioDeviceStop(_aggregate, _proc); AudioDeviceDestroyIOProcID(_aggregate, _proc); }
  _proc = NULL;
  if (_aggregate) AudioHardwareDestroyAggregateDevice(_aggregate);
  _aggregate = kAudioObjectUnknown;
  if (_tap) { if (@available(macOS 14.2, *)) AudioHardwareDestroyProcessTap(_tap); }
  _tap = kAudioObjectUnknown;
}

- (void)stop:(NSString *)problem {
  self.stopped = YES;
  dispatch_async(TTMeetingControl(), ^{
    AVAudioEngine *engine = self.engine;
    self.engine = nil;
    if (engine) {
      [NSNotificationCenter.defaultCenter removeObserver:self name:AVAudioEngineConfigurationChangeNotification object:engine];
      [engine stop];
      @try { [engine.inputNode removeTapOnBus:0]; } @catch (NSException *exception) { (void)exception; }
    }
    if (self->_outputChanged) {
      AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
      AudioObjectRemovePropertyListenerBlock(kAudioObjectSystemObject, &address, TTMeetingControl(), self->_outputChanged);
      self->_outputChanged = nil;
    }
    [self closeSystem];
    // Behind every buffer still on its way, so the meeting ends with all of its audio.
    dispatch_async(TTMeetingAudio(), ^{
      dictate_meeting_end(problem.UTF8String);
      dispatch_async(dispatch_get_main_queue(), ^{ TTMeetingClosed(); });
    });
  });
}
@end

static bool TTMeetingMicAllowed(void) {
  if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] == AVAuthorizationStatusAuthorized) return true;
  dictate_ui_error("microphone"); // the overlay shows its microphone card for this one
  return false;
}

// False with the reason in meeting.rs, or the microphone card shown.
static bool TTMeetingStart(void) {
  if (!TTMeetingMicAllowed()) return false;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // A closed lid ends the meeting: it is saved rather than left open across the sleep.
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceWillSleepNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
      (void)note;
      startWhenClosed = NO;
      if (recorder) TTMeetingStop(nil);
    }];
  });
  NSDateFormatter *format = [NSDateFormatter new];
  format.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
  format.dateFormat = @"yyyy-MM-dd HH.mm";
  int system = dictate_meeting_begin([format stringFromDate:NSDate.date].UTF8String);
  if (system < 0) return false;
  recorder = [TTMeetingRecorder new];
  [recorder start:system == 1];
  return true;
}

// `action` is "start", "stop" or "toggle" (the meeting shortcut); on the main thread. False when
// nothing changed. Starting while a meeting records answers true: the meeting asked for is recording.
// Starting while the last one closes answers true too: it starts once that one is in.
bool dictate_meeting(const char *action) {
  if (!action) return false;
  NSString *what = @(action);
  if ([what isEqual:@"toggle"]) what = recorder || startWhenClosed ? @"stop" : @"start";
  if ([what isEqual:@"stop"]) {
    if (startWhenClosed) { startWhenClosed = NO; return true; }
    if (!recorder) return false;
    TTMeetingStop(nil);
    return true;
  }
  if (![what isEqual:@"start"]) return false;
  if (recorder || startWhenClosed) return true;
  if (!closing) return TTMeetingStart();
  if (!TTMeetingMicAllowed()) return false;
  startWhenClosed = YES;
  return true;
}

// Bytes free on the volume that holds `path`, counting what macOS would clear to make room; -1 when
// it can't tell. From any thread.
int64_t dictate_meeting_free_space(const char *path) {
  if (!path) return -1;
  @autoreleasepool {
    NSNumber *free;
    if (![[NSURL fileURLWithPath:@(path)] getResourceValue:&free forKey:NSURLVolumeAvailableCapacityForImportantUsageKey error:nil] || !free) return -1;
    return free.longLongValue;
  }
}
