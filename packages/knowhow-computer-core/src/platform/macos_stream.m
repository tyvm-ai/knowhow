// macOS ScreenCaptureKit persistent stream bridge.
// Compiled as an Objective-C translation unit; linked into the napi addon.
// Requires macOS 12.3+ (ScreenCaptureKit) and Screen Recording TCC permission.
//
// C API (declared in macos_stream.rs extern "C" block):
//   knowhow_stream_start(opts*) -> uint64_t  stream_id, 0 = error
//   knowhow_stream_latest_frame(stream_id, after_sequence, ...) -> int 1/0
//   knowhow_stream_stop(stream_id)

#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Accelerate/Accelerate.h>
#import <dispatch/dispatch.h>
#import <os/lock.h>
#import <stdint.h>
#import <string.h>
#import <stdlib.h>
#import <time.h>

// ── Options struct (keep in sync with macos_stream.rs) ──────────────────────

typedef struct {
    double   region_x;
    double   region_y;
    double   region_w;
    double   region_h;
    int32_t  use_region;     // 1 = honour region_*, 0 = whole display
    uint32_t display_id;     // CGDirectDisplayID; 0 = main display
    float    scale;          // 0 < scale <= 1; 1.0 = native resolution
    float    fps;            // desired frames/sec (clamped 1..60)
    uint32_t frames_to_keep; // ring-buffer capacity  (clamped 1..256)
} KnowhowStreamOptions;

// ── Frame ring buffer ────────────────────────────────────────────────────────

typedef struct {
    uint8_t  *data;            // RGBA bytes (malloc'd); NULL = empty slot
    uint32_t  width;
    uint32_t  height;
    uint64_t  sequence;
    int64_t   captured_at_ms;
} KnowhowFrame;

typedef struct {
    KnowhowFrame  *frames;
    uint32_t       capacity;
    uint32_t       write_idx;
    uint64_t       next_seq;
    os_unfair_lock lock;
} KnowhowFrameRing;

static KnowhowFrameRing *ring_alloc(uint32_t capacity) {
    KnowhowFrameRing *r = calloc(1, sizeof(KnowhowFrameRing));
    r->frames    = calloc(capacity, sizeof(KnowhowFrame));
    r->capacity  = capacity;
    r->next_seq  = 1;
    r->lock      = OS_UNFAIR_LOCK_INIT;
    return r;
}

static void ring_free(KnowhowFrameRing *r) {
    if (!r) return;
    for (uint32_t i = 0; i < r->capacity; i++) free(r->frames[i].data);
    free(r->frames);
    free(r);
}

static void ring_push(KnowhowFrameRing *r,
                      const uint8_t *rgba, uint32_t width, uint32_t height,
                      int64_t captured_at_ms) {
    os_unfair_lock_lock(&r->lock);
    KnowhowFrame *slot = &r->frames[r->write_idx];
    uint32_t sz = width * height * 4;
    if (!slot->data || slot->width != width || slot->height != height) {
        free(slot->data);
        slot->data = malloc(sz);
    }
    if (slot->data) {
        memcpy(slot->data, rgba, sz);
        slot->width          = width;
        slot->height         = height;
        slot->sequence       = r->next_seq++;
        slot->captured_at_ms = captured_at_ms;
    }
    r->write_idx = (r->write_idx + 1) % r->capacity;
    os_unfair_lock_unlock(&r->lock);
}

// Returns 1 and copies latest frame (sequence > after_sequence) into out_*.
// *out_data is malloc'd — caller must free().
static int ring_latest(KnowhowFrameRing *r, uint64_t after_sequence,
                       uint8_t **out_data, uint32_t *out_width, uint32_t *out_height,
                       uint64_t *out_seq, int64_t *out_ts_ms) {
    os_unfair_lock_lock(&r->lock);
    KnowhowFrame *best = NULL;
    for (uint32_t i = 0; i < r->capacity; i++) {
        KnowhowFrame *f = &r->frames[i];
        if (!f->data || f->sequence <= after_sequence) continue;
        if (!best || f->sequence > best->sequence) best = f;
    }
    if (!best) { os_unfair_lock_unlock(&r->lock); return 0; }
    uint32_t sz = best->width * best->height * 4;
    uint8_t *copy = malloc(sz);
    if (!copy)   { os_unfair_lock_unlock(&r->lock); return 0; }
    memcpy(copy, best->data, sz);
    *out_data  = copy;
    *out_width  = best->width;
    *out_height = best->height;
    *out_seq    = best->sequence;
    *out_ts_ms  = best->captured_at_ms;
    os_unfair_lock_unlock(&r->lock);
    return 1;
}

// ── Stream record ────────────────────────────────────────────────────────────

@class KnowhowStreamDelegate;

typedef struct {
    uint64_t              stream_id;
    void                 *stream_retained;  // __bridge_retained SCStream *
    KnowhowStreamDelegate *delegate;
    dispatch_queue_t       output_queue;
    KnowhowFrameRing     *ring;
    float                 scale;
} KnowhowStreamRecord;

// ── Global registry ──────────────────────────────────────────────────────────

static os_unfair_lock        g_lock     = OS_UNFAIR_LOCK_INIT;
static KnowhowStreamRecord **g_records  = NULL;
static uint32_t              g_len      = 0;
static uint32_t              g_cap      = 0;
static uint64_t              g_next_id  = 1;

static void registry_add(KnowhowStreamRecord *rec) {
    os_unfair_lock_lock(&g_lock);
    if (g_len == g_cap) {
        uint32_t nc = g_cap == 0 ? 4 : g_cap * 2;
        g_records = realloc(g_records, nc * sizeof(void *));
        g_cap = nc;
    }
    g_records[g_len++] = rec;
    os_unfair_lock_unlock(&g_lock);
}

// Removes record from registry and returns it (caller owns it after this).
static KnowhowStreamRecord *registry_take(uint64_t stream_id) {
    os_unfair_lock_lock(&g_lock);
    KnowhowStreamRecord *found = NULL;
    for (uint32_t i = 0; i < g_len; i++) {
        if (g_records[i]->stream_id == stream_id) {
            found = g_records[i];
            g_records[i] = g_records[--g_len];
            break;
        }
    }
    os_unfair_lock_unlock(&g_lock);
    return found;
}

static KnowhowStreamRecord *registry_find(uint64_t stream_id) {
    os_unfair_lock_lock(&g_lock);
    KnowhowStreamRecord *found = NULL;
    for (uint32_t i = 0; i < g_len; i++) {
        if (g_records[i]->stream_id == stream_id) { found = g_records[i]; break; }
    }
    os_unfair_lock_unlock(&g_lock);
    return found;
}

// ── Delegate ─────────────────────────────────────────────────────────────────

@interface KnowhowStreamDelegate : NSObject <SCStreamDelegate, SCStreamOutput>
@property (nonatomic, assign) KnowhowStreamRecord *record;
@end

@implementation KnowhowStreamDelegate

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen) return;
    CVImageBufferRef ib = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!ib) return;

    // Presentation timestamps are monotonic within the stream. Absolute epoch
    // time is neither needed nor desirable for motion deltas.
    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    int64_t captured_at_ms;
    if (CMTIME_IS_VALID(pts) && CMTimeGetSeconds(pts) > 0) {
        captured_at_ms = (int64_t)(CMTimeGetSeconds(pts) * 1000.0);
    } else {
        struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
        captured_at_ms = (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
    }

    CVPixelBufferLockBaseAddress(ib, kCVPixelBufferLock_ReadOnly);
    size_t width    = CVPixelBufferGetWidth(ib);
    size_t height   = CVPixelBufferGetHeight(ib);
    size_t rowBytes = CVPixelBufferGetBytesPerRow(ib);
    uint8_t *src    = CVPixelBufferGetBaseAddress(ib);

    float scale = self.record->scale;
    uint32_t out_w = (uint32_t)((double)width  * scale + 0.5);
    uint32_t out_h = (uint32_t)((double)height * scale + 0.5);
    if (out_w < 1) out_w = 1;
    if (out_h < 1) out_h = 1;

    // Convert BGRA -> RGBA via vImage channel permutation.
    uint8_t *rgba_native = malloc(width * height * 4);
    if (!rgba_native) {
        CVPixelBufferUnlockBaseAddress(ib, kCVPixelBufferLock_ReadOnly);
        return;
    }

    OSType fmt = CVPixelBufferGetPixelFormatType(ib);
    if (fmt == kCVPixelFormatType_32BGRA) {
        vImage_Buffer vSrc = { src,         height, width, rowBytes    };
        vImage_Buffer vDst = { rgba_native, height, width, width * 4   };
        const uint8_t perm[4] = { 2, 1, 0, 3 };  // BGRA -> RGBA
        vImagePermuteChannels_ARGB8888(&vSrc, &vDst, perm, kvImageNoFlags);
    } else {
        // Assume RGBA / unknown: copy row-by-row.
        for (size_t r = 0; r < height; r++)
            memcpy(rgba_native + r * width * 4, src + r * rowBytes, width * 4);
    }
    CVPixelBufferUnlockBaseAddress(ib, kCVPixelBufferLock_ReadOnly);

    uint8_t *final_rgba = rgba_native;
    uint32_t final_w = (uint32_t)width;
    uint32_t final_h = (uint32_t)height;

    if (out_w != final_w || out_h != final_h) {
        uint8_t *scaled = malloc(out_w * out_h * 4);
        if (scaled) {
            vImage_Buffer vSrc2 = { rgba_native, final_h, final_w, final_w * 4 };
            vImage_Buffer vDst2 = { scaled,      out_h,   out_w,   out_w  * 4 };
            vImageScale_ARGB8888(&vSrc2, &vDst2, NULL, kvImageHighQualityResampling);
            free(rgba_native);
            final_rgba = scaled;
            final_w = out_w;
            final_h = out_h;
        }
    }

    ring_push(self.record->ring, final_rgba, final_w, final_h, captured_at_ms);
    free(final_rgba);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    if (error) NSLog(@"[knowhow-stream %llu] stopped: %@",
                     (unsigned long long)self.record->stream_id, error);
}

@end

// ── C API ────────────────────────────────────────────────────────────────────

uint64_t knowhow_stream_start(const KnowhowStreamOptions *opts) {
    if (!opts) return 0;

    float    scale    = (opts->scale > 0 && opts->scale <= 1.0f) ? opts->scale : 1.0f;
    float    fps      = (opts->fps   > 0 && opts->fps   <= 60.0f) ? opts->fps  : 10.0f;
    uint32_t capacity = (opts->frames_to_keep >= 1 && opts->frames_to_keep <= 256)
                        ? opts->frames_to_keep : 4;
    uint32_t req_display = opts->display_id;

    __block uint64_t result_id = 0;
    dispatch_semaphore_t outer_sem = dispatch_semaphore_create(0);

    dispatch_queue_t setup_q = dispatch_queue_create(
        "com.knowhow.stream_setup", DISPATCH_QUEUE_SERIAL);

    dispatch_async(setup_q, ^{
        // ── 1. Discover SCDisplay ──────────────────────────────────────────
        __block SCDisplay *scDisplay = nil;
        dispatch_semaphore_t content_sem = dispatch_semaphore_create(0);

        [SCShareableContent getShareableContentWithCompletionHandler:
         ^(SCShareableContent *content, NSError *err) {
            if (!err) {
                CGDirectDisplayID want = req_display ? (CGDirectDisplayID)req_display
                                                     : CGMainDisplayID();
                if (!req_display && opts->use_region) {
                    CGPoint center = CGPointMake(opts->region_x + opts->region_w / 2.0,
                                                 opts->region_y + opts->region_h / 2.0);
                    for (SCDisplay *d in content.displays) {
                        if (CGRectContainsPoint(CGDisplayBounds((CGDirectDisplayID)d.displayID), center)) {
                            want = (CGDirectDisplayID)d.displayID;
                            break;
                        }
                    }
                }
                for (SCDisplay *d in content.displays) {
                    if ((CGDirectDisplayID)d.displayID == want) { scDisplay = d; break; }
                }
                if (!scDisplay) scDisplay = content.displays.firstObject;
            } else {
                NSLog(@"[knowhow-stream] SCShareableContent: %@", err);
            }
            dispatch_semaphore_signal(content_sem);
        }];
        dispatch_semaphore_wait(content_sem,
            dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));

        if (!scDisplay) { dispatch_semaphore_signal(outer_sem); return; }

        // ── 2. Build filter + config ───────────────────────────────────────
        SCContentFilter *filter =
            [[SCContentFilter alloc] initWithDisplay:scDisplay excludingWindows:@[]];

        SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
        cfg.minimumFrameInterval = CMTimeMake(1, (int32_t)fps);
        cfg.pixelFormat          = kCVPixelFormatType_32BGRA;
        cfg.showsCursor          = NO;

        CGDirectDisplayID cgDisp = (CGDirectDisplayID)scDisplay.displayID;
        size_t native_w = CGDisplayPixelsWide(cgDisp);
        size_t native_h = CGDisplayPixelsHigh(cgDisp);

        if (opts->use_region && opts->region_w > 0 && opts->region_h > 0) {
            CGRect logBounds = CGDisplayBounds(cgDisp);
            double sf = logBounds.size.width > 0
                        ? (double)native_w / logBounds.size.width : 1.0;
            size_t cw = (size_t)(opts->region_w * sf + 0.5);
            size_t ch = (size_t)(opts->region_h * sf + 0.5);
            cfg.width  = cw > 0 ? cw : 1;
            cfg.height = ch > 0 ? ch : 1;
            // sourceRect is in display-local logical points; cfg width/height
            // are output pixels. SDK regions use virtual-desktop coordinates.
            cfg.sourceRect = CGRectMake(opts->region_x - logBounds.origin.x,
                                        opts->region_y - logBounds.origin.y,
                                        opts->region_w, opts->region_h);
        } else {
            cfg.width  = native_w;
            cfg.height = native_h;
        }

        // ── 3. Allocate record ─────────────────────────────────────────────
        KnowhowStreamRecord *rec = calloc(1, sizeof(KnowhowStreamRecord));
        rec->ring  = ring_alloc(capacity);
        rec->scale = scale;

        os_unfair_lock_lock(&g_lock);
        rec->stream_id = g_next_id++;
        os_unfair_lock_unlock(&g_lock);

        KnowhowStreamDelegate *delegate = [[KnowhowStreamDelegate alloc] init];
        delegate.record = rec;
        rec->delegate   = delegate;

        // ── 4. Create SCStream ─────────────────────────────────────────────
        SCStream *stream = [[SCStream alloc] initWithFilter:filter
                                              configuration:cfg
                                                   delegate:delegate];

        dispatch_queue_t out_q = dispatch_queue_create(
            "com.knowhow.stream_output", DISPATCH_QUEUE_SERIAL);
        rec->output_queue = out_q;
        NSError *addErr = nil;
        if (![stream addStreamOutput:delegate
                                type:SCStreamOutputTypeScreen
                  sampleHandlerQueue:out_q
                               error:&addErr]) {
            NSLog(@"[knowhow-stream] addStreamOutput: %@", addErr);
            rec->delegate = nil;
            rec->output_queue = nil;
            ring_free(rec->ring);
            free(rec);
            dispatch_semaphore_signal(outer_sem);
            return;
        }

        // Retain SCStream across the ARC boundary so it survives in the record.
        rec->stream_retained = (__bridge_retained void *)stream;

        // ── 5. Start capture ──────────────────────────────────────────────
        dispatch_semaphore_t start_sem = dispatch_semaphore_create(0);
        __block BOOL ok = NO;
        [stream startCaptureWithCompletionHandler:^(NSError *err) {
            if (err) NSLog(@"[knowhow-stream] startCapture: %@", err);
            else     ok = YES;
            dispatch_semaphore_signal(start_sem);
        }];
        dispatch_semaphore_wait(start_sem,
            dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));

        if (!ok) {
            CFRelease(rec->stream_retained);
            rec->delegate = nil;
            rec->output_queue = nil;
            ring_free(rec->ring);
            free(rec);
            dispatch_semaphore_signal(outer_sem);
            return;
        }

        registry_add(rec);
        result_id = rec->stream_id;
        dispatch_semaphore_signal(outer_sem);
    });

    dispatch_semaphore_wait(outer_sem,
        dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC));
    return result_id;
}

int knowhow_stream_latest_frame(uint64_t  stream_id,
                                uint64_t  after_sequence,
                                uint8_t **out_data,
                                uint32_t *out_width,
                                uint32_t *out_height,
                                uint64_t *out_sequence,
                                int64_t  *out_captured_at_ms) {
    KnowhowStreamRecord *rec = registry_find(stream_id);
    if (!rec) return 0;
    return ring_latest(rec->ring, after_sequence,
                       out_data, out_width, out_height,
                       out_sequence, out_captured_at_ms);
}

void knowhow_stream_stop(uint64_t stream_id) {
    KnowhowStreamRecord *rec = registry_take(stream_id);
    if (!rec) return;
    SCStream *stream = (__bridge_transfer SCStream *)rec->stream_retained;
    rec->stream_retained = NULL;
    dispatch_semaphore_t stop_sem = dispatch_semaphore_create(0);
    [stream stopCaptureWithCompletionHandler:^(NSError *err) {
        if (err) NSLog(@"[knowhow-stream %llu] stopCapture: %@",
                       (unsigned long long)rec->stream_id, err);
        dispatch_semaphore_signal(stop_sem);
    }];
    // Do not free callback-owned state until ScreenCaptureKit confirms stop.
    dispatch_semaphore_wait(stop_sem, DISPATCH_TIME_FOREVER);
    // Drain callbacks before invalidating the delegate's record pointer.
    dispatch_sync(rec->output_queue, ^{});
    rec->delegate.record = NULL;
    rec->delegate = nil;
    rec->output_queue = nil;
    ring_free(rec->ring);
    free(rec);
}
