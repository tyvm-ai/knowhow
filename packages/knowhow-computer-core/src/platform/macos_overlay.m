#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>

// Keep this ABI in sync with NativeOverlayPrimitive in macos_overlay.rs.
typedef struct {
  int32_t kind; // 0 rect, 1 circle, 2 line, 3 point
  double x;
  double y;
  double width;
  double height;
  double x2;
  double y2;
  double red;
  double green;
  double blue;
  double alpha;
  double line_width;
} KnowhowOverlayPrimitive;

@interface KnowhowOverlayView : NSView
@property(nonatomic, copy) NSArray<NSDictionary *> *primitives;
@property(nonatomic) CGFloat desktopTop;
@property(nonatomic) NSPoint screenOrigin;
@end

@implementation KnowhowOverlayView
- (BOOL)isOpaque { return NO; }
- (BOOL)acceptsFirstResponder { return NO; }

- (void)drawRect:(NSRect)dirtyRect {
  [super drawRect:dirtyRect];
  CGContextRef context = NSGraphicsContext.currentContext.CGContext;
  CGContextSetLineCap(context, kCGLineCapRound);
  CGContextSetLineJoin(context, kCGLineJoinRound);

  for (NSDictionary *item in self.primitives) {
    const int kind = [item[@"kind"] intValue];
    const CGFloat x = [item[@"x"] doubleValue];
    const CGFloat y = [item[@"y"] doubleValue];
    const CGFloat width = [item[@"width"] doubleValue];
    const CGFloat height = [item[@"height"] doubleValue];
    const CGFloat x2 = [item[@"x2"] doubleValue];
    const CGFloat y2 = [item[@"y2"] doubleValue];
    const CGFloat lineWidth = MAX(1.0, [item[@"lineWidth"] doubleValue]);
    NSColor *color = [NSColor colorWithCalibratedRed:[item[@"red"] doubleValue]
                                                green:[item[@"green"] doubleValue]
                                                 blue:[item[@"blue"] doubleValue]
                                                alpha:[item[@"alpha"] doubleValue]];
    CGContextSetStrokeColorWithColor(context, color.CGColor);
    CGContextSetFillColorWithColor(context, color.CGColor);
    CGContextSetLineWidth(context, lineWidth);

    // Input uses the computer-use virtual desktop (top-left origin). AppKit's
    // global coordinate space has its origin at the primary display's bottom-left.
    const CGFloat cocoaY = self.desktopTop - y;
    if (kind == 0 || kind == 1) {
      NSRect localRect = NSMakeRect(x - self.screenOrigin.x,
                                    cocoaY - height - self.screenOrigin.y,
                                    width, height);
      if (kind == 0) CGContextStrokeRect(context, NSRectToCGRect(localRect));
      else CGContextStrokeEllipseInRect(context, NSRectToCGRect(localRect));
    } else if (kind == 2) {
      NSPoint from = NSMakePoint(x - self.screenOrigin.x, cocoaY - self.screenOrigin.y);
      NSPoint to = NSMakePoint(x2 - self.screenOrigin.x,
                               self.desktopTop - y2 - self.screenOrigin.y);
      CGContextBeginPath(context);
      CGContextMoveToPoint(context, from.x, from.y);
      CGContextAddLineToPoint(context, to.x, to.y);
      CGContextStrokePath(context);
    } else {
      NSPoint center = NSMakePoint(x - self.screenOrigin.x, cocoaY - self.screenOrigin.y);
      const CGFloat radius = MAX(2.0, width > 0 ? width / 2.0 : lineWidth * 1.5);
      CGContextFillEllipseInRect(context, CGRectMake(center.x - radius, center.y - radius,
                                                      radius * 2.0, radius * 2.0));
    }
  }
}
@end

static NSMutableArray<NSPanel *> *knowhowPanels;

static void knowhow_on_main(void (^block)(void)) {
  if ([NSThread isMainThread]) block();
  else dispatch_sync(dispatch_get_main_queue(), block);
}

static void knowhow_clear_panels(void) {
  for (NSPanel *panel in knowhowPanels) [panel orderOut:nil];
  [knowhowPanels removeAllObjects];
}


void knowhow_overlay_show(const KnowhowOverlayPrimitive *items, size_t count) {
  // Copy across the FFI boundary before dispatching. The Rust Vec is only valid
  // for the duration of this call.
  NSMutableArray<NSDictionary *> *primitives = [NSMutableArray arrayWithCapacity:count];
  for (size_t i = 0; i < count; i++) {
    const KnowhowOverlayPrimitive p = items[i];
    [primitives addObject:@{
      @"kind": @(p.kind), @"x": @(p.x), @"y": @(p.y),
      @"width": @(p.width), @"height": @(p.height),
      @"x2": @(p.x2), @"y2": @(p.y2),
      @"red": @(p.red), @"green": @(p.green), @"blue": @(p.blue),
      @"alpha": @(p.alpha), @"lineWidth": @(p.line_width)
    }];
  }

  knowhow_on_main(^{
    if (!knowhowPanels) knowhowPanels = [NSMutableArray array];
    knowhow_clear_panels();
    if (primitives.count == 0) return;

    [NSApplication sharedApplication];
    NSArray<NSScreen *> *screens = NSScreen.screens;
    NSScreen *primary = NSScreen.mainScreen ?: screens.firstObject;
    const CGFloat desktopTop = NSMaxY(primary.frame);

    for (NSScreen *screen in screens) {
      NSPanel *panel = [[NSPanel alloc]
        initWithContentRect:screen.frame
                  styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                    backing:NSBackingStoreBuffered
                      defer:NO];
      panel.opaque = NO;
      panel.backgroundColor = NSColor.clearColor;
      panel.hasShadow = NO;
      panel.ignoresMouseEvents = YES;
      panel.level = NSScreenSaverWindowLevel;
      panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                 NSWindowCollectionBehaviorFullScreenAuxiliary |
                                 NSWindowCollectionBehaviorStationary;
      // Keep annotations out of normal screen capture so perception cannot
      // recursively detect its own debug geometry.
      panel.sharingType = NSWindowSharingNone;

      KnowhowOverlayView *view = [[KnowhowOverlayView alloc] initWithFrame:panel.contentView.bounds];
      view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      view.primitives = primitives;
      view.desktopTop = desktopTop;
      view.screenOrigin = screen.frame.origin;
      panel.contentView = view;
      [panel orderFrontRegardless];
      [view setNeedsDisplay:YES];
      [knowhowPanels addObject:panel];
    }
  });
}

void knowhow_overlay_clear(void) {
  knowhow_on_main(^{
    if (knowhowPanels) knowhow_clear_panels();
  });
}
