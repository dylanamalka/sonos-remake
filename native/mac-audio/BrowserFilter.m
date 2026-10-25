#import "BrowserFilter.h"
SCContentFilter *CurrentBrowserFilter(SCDisplay *display, NSArray<SCRunningApplication *> *applications) {
    return [[SCContentFilter alloc] initWithDisplay:display includingApplications:applications exceptingWindows:@[]];
}
