// Small AppKit helpers for the macOS backend: clipboard text, beep, and bundle
// id lookup. Plain C ABI so Rust can call them without an objc crate.
#import <AppKit/AppKit.h>
#include <stdlib.h>
#include <string.h>

// Returns a malloc'd UTF-8 string (free with kh_free_string) or NULL when the
// general pasteboard holds no plain text.
char *kh_clipboard_get_text(void) {
  @autoreleasepool {
    NSString *s = [[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString];
    if (s == nil) return NULL;
    const char *utf8 = [s UTF8String];
    return utf8 ? strdup(utf8) : NULL;
  }
}

// Returns 1 on success, 0 on failure.
int kh_clipboard_set_text(const char *text) {
  @autoreleasepool {
    NSString *s = [NSString stringWithUTF8String:text ? text : ""];
    if (s == nil) return 0;
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    [pb clearContents];
    return [pb setString:s forType:NSPasteboardTypeString] ? 1 : 0;
  }
}

long kh_clipboard_change_count(void) {
  @autoreleasepool {
    return (long)[[NSPasteboard generalPasteboard] changeCount];
  }
}

void kh_beep(void) { NSBeep(); }

// Returns a malloc'd bundle identifier for pid, or NULL.
char *kh_bundle_id_for_pid(int pid) {
  @autoreleasepool {
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
    NSString *bid = app.bundleIdentifier;
    if (bid == nil) return NULL;
    const char *utf8 = [bid UTF8String];
    return utf8 ? strdup(utf8) : NULL;
  }
}

// Fallback when NSRunningApplication has no record of the pid (common in
// non-AppKit host processes such as node): find the outermost enclosing .app
// bundle of the executable path and read its CFBundleIdentifier.
char *kh_bundle_id_for_exe_path(const char *path) {
  @autoreleasepool {
    if (path == NULL) return NULL;
    NSString *p = [NSString stringWithUTF8String:path];
    NSRange r = [p rangeOfString:@".app/"];
    if (r.location == NSNotFound) return NULL;
    NSString *appPath = [p substringToIndex:r.location + 4];
    NSBundle *b = [NSBundle bundleWithPath:appPath];
    NSString *bid = b.bundleIdentifier;
    if (bid == nil) return NULL;
    const char *utf8 = [bid UTF8String];
    return utf8 ? strdup(utf8) : NULL;
  }
}

void kh_free_string(char *p) { free(p); }
