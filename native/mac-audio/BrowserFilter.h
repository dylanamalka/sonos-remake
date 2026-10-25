#import <ScreenCaptureKit/ScreenCaptureKit.h>
// Public Objective-C selector, verified against ScreenCaptureKit's API bindings.
// A C bridge makes the positive application allowlist independent of Swift importer labels.
SCContentFilter * _Nonnull CurrentBrowserFilter(SCDisplay * _Nonnull display, NSArray<SCRunningApplication *> * _Nonnull applications) API_AVAILABLE(macos(12.3));
