#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>

// The apps someone may want a style for, for Settings › App styles: those running now and those used
// in the last month (Spotlight's last-used date), each with its name and a small icon.

static const NSInteger TTVoiceIconSide = 64; // 32 points at 2x
static const NSUInteger TTVoiceRecentApps = 40;

static NSString *TTVoiceIcon(NSImage *image) {
  if (!image) return nil;
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:TTVoiceIconSide pixelsHigh:TTVoiceIconSide
    bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
  NSGraphicsContext *context = bitmap ? [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap] : nil;
  if (!context) return nil;
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext = context;
  [image drawInRect:NSMakeRect(0, 0, TTVoiceIconSide, TTVoiceIconSide) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1];
  [NSGraphicsContext restoreGraphicsState];
  NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  return png ? [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]] : nil;
}

// An app someone opens and types in: not a helper inside another app, an agent or a background tool.
static NSBundle *TTVoiceApp(NSString *path) {
  if (!path || [path containsString:@".app/"]) return nil;
  NSBundle *bundle = [NSBundle bundleWithPath:path];
  NSDictionary *info = bundle.infoDictionary;
  if (!bundle.bundleIdentifier || [info[@"LSUIElement"] boolValue] || [info[@"LSBackgroundOnly"] boolValue]) return nil;
  return bundle;
}

static NSString *TTVoiceAppName(NSBundle *bundle, NSString *path) {
  NSString *name = [bundle objectForInfoDictionaryKey:@"CFBundleDisplayName"] ?: [bundle objectForInfoDictionaryKey:@"CFBundleName"];
  if ([name isKindOfClass:NSString.class] && name.length) return name;
  return [[NSFileManager.defaultManager displayNameAtPath:path] stringByDeletingPathExtension];
}

// Apps by when they were last used, newest first.
static NSArray<NSString *> *TTVoiceRecentPaths(void) {
  MDQueryRef query = MDQueryCreate(kCFAllocatorDefault, CFSTR("kMDItemContentType == 'com.apple.application-bundle' && kMDItemLastUsedDate >= $time.today(-30)"), NULL, NULL);
  if (!query) return @[];
  NSMutableArray<NSDictionary *> *found = [NSMutableArray new];
  if (MDQueryExecute(query, kMDQuerySynchronous)) {
    for (CFIndex i = 0; i < MDQueryGetResultCount(query); i++) {
      MDItemRef item = (MDItemRef)MDQueryGetResultAtIndex(query, i);
      NSString *path = (__bridge_transfer NSString *)MDItemCopyAttribute(item, kMDItemPath);
      NSDate *used = (__bridge_transfer NSDate *)MDItemCopyAttribute(item, kMDItemLastUsedDate);
      if ([path isKindOfClass:NSString.class] && [used isKindOfClass:NSDate.class]) [found addObject:@{@"path": path, @"used": used}];
    }
  }
  CFRelease(query);
  [found sortUsingDescriptors:@[[NSSortDescriptor sortDescriptorWithKey:@"used" ascending:NO]]];
  return [found valueForKey:@"path"];
}

// JSON: [{ bundleId, name, icon, running, recent }], running apps first. `known_json` is a JSON list of
// bundle ids whose name and icon are wanted too, when they are installed. The caller frees the answer
// with dictate_free.
char *dictate_apps(const char *known_json) {
  @autoreleasepool {
    NSMutableArray<NSMutableDictionary *> *apps = [NSMutableArray new];
    NSMutableDictionary<NSString *, NSMutableDictionary *> *byId = [NSMutableDictionary new];
    NSString *me = NSBundle.mainBundle.bundleIdentifier;
    NSMutableDictionary *(^add)(NSString *, NSString *, NSImage *) = ^NSMutableDictionary *(NSString *bundleId, NSString *name, NSImage *icon) {
      NSString *key = bundleId.lowercaseString;
      if (!bundleId.length || !name.length || [bundleId isEqualToString:me]) return nil;
      NSMutableDictionary *app = byId[key];
      if (app) return app;
      app = [@{@"bundleId": bundleId, @"name": name, @"icon": TTVoiceIcon(icon) ?: NSNull.null, @"running": @NO, @"recent": @NO} mutableCopy];
      byId[key] = app;
      [apps addObject:app];
      return app;
    };
    NSArray<NSRunningApplication *> *running = [NSWorkspace.sharedWorkspace.runningApplications filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(NSRunningApplication *app, NSDictionary *bindings) { (void)bindings; return app.activationPolicy == NSApplicationActivationPolicyRegular; }]];
    running = [running sortedArrayUsingComparator:^NSComparisonResult(NSRunningApplication *one, NSRunningApplication *other) {
      return [one.localizedName ?: @"" localizedCaseInsensitiveCompare:other.localizedName ?: @""];
    }];
    for (NSRunningApplication *app in running) add(app.bundleIdentifier, app.localizedName, app.icon)[@"running"] = @YES;
    NSUInteger recent = 0;
    for (NSString *path in TTVoiceRecentPaths()) {
      if (recent >= TTVoiceRecentApps) break;
      NSBundle *bundle = TTVoiceApp(path);
      if (!bundle) continue;
      NSMutableDictionary *app = add(bundle.bundleIdentifier, TTVoiceAppName(bundle, path), [NSWorkspace.sharedWorkspace iconForFile:path]);
      if (app) { app[@"recent"] = @YES; recent++; }
    }
    NSData *data = known_json ? [NSData dataWithBytes:known_json length:strlen(known_json)] : nil;
    id known = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    for (id bundleId in [known isKindOfClass:NSArray.class] ? known : @[]) {
      if (![bundleId isKindOfClass:NSString.class] || byId[[bundleId lowercaseString]]) continue;
      NSURL *url = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:bundleId];
      if (!url) continue;
      add(bundleId, TTVoiceAppName([NSBundle bundleWithURL:url], url.path), [NSWorkspace.sharedWorkspace iconForFile:url.path]);
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:apps options:0 error:nil];
    if (!json) return NULL;
    char *out = malloc(json.length + 1);
    if (!out) return NULL;
    memcpy(out, json.bytes, json.length);
    out[json.length] = 0;
    return out;
  }
}

void dictate_free(char *text) { free(text); }
