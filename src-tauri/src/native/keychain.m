#import <Foundation/Foundation.h>
#import <Security/Security.h>

// An API key, as one generic password in the login Keychain per provider (`account`: "anthropic", "openai").
// It is never written anywhere else: Rust reads it just before a request and lets it go after.

static NSMutableDictionary *TTKeyQuery(const char *account) {
  return [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: @"com.tabtasker.dictate",
    (__bridge id)kSecAttrAccount: account && *account ? @(account) : @"anthropic",
  } mutableCopy];
}

// Replaces any saved key for `account` with `key`.
bool dictate_keychain_set(const char *account, const char *key) {
  if (!key || !*key) return false;
  NSData *secret = [NSData dataWithBytes:key length:strlen(key)];
  NSMutableDictionary *query = TTKeyQuery(account);
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)@{ (__bridge id)kSecValueData: secret });
  if (status == errSecItemNotFound) {
    query[(__bridge id)kSecValueData] = secret;
    query[(__bridge id)kSecAttrLabel] = [NSString stringWithFormat:@"TabTasker Dictate: %@ API key", [query[(__bridge id)kSecAttrAccount] isEqual:@"openai"] ? @"OpenAI-compatible" : @"Anthropic"];
    status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
  }
  return status == errSecSuccess;
}

// The key into `output`, NUL-terminated. False when there is none or it doesn't fit.
bool dictate_keychain_get(const char *account, char *output, size_t capacity) {
  if (!output || capacity == 0) return false;
  NSMutableDictionary *query = TTKeyQuery(account);
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef found = NULL;
  if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &found) != errSecSuccess || !found) return false;
  NSData *secret = (__bridge_transfer NSData *)found;
  if (![secret isKindOfClass:NSData.class] || secret.length == 0 || secret.length >= capacity) return false;
  memcpy(output, secret.bytes, secret.length);
  output[secret.length] = 0;
  return true;
}

// Whether a key is saved, without reading it: asking for attributes only never shows a Keychain prompt.
bool dictate_keychain_exists(const char *account) {
  NSMutableDictionary *query = TTKeyQuery(account);
  query[(__bridge id)kSecReturnAttributes] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef found = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
  if (found) CFRelease(found);
  return status == errSecSuccess;
}

// True once no key is saved, including when there was none.
bool dictate_keychain_delete(const char *account) {
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)TTKeyQuery(account));
  return status == errSecSuccess || status == errSecItemNotFound;
}
