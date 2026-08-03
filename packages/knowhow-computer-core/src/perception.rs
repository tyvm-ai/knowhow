//! Native perception primitives — the performance-heavy pixel loops that the TS
//! `perception.ts` mirrors. Kept as free `#[napi]` functions that operate purely
//! on caller-provided RGBA bytes (no screen access), so they are:
//!   * fast (tight Rust loops instead of JS per-pixel iteration),
//!   * pure/testable (feed synthetic frames), and
//!   * reusable from the game loop (color scan runs every tick).
//!
//! The TS layer prefers these when the native core is loaded and transparently
//! falls back to the pure-TS implementation otherwise, so behavior is identical
//! either way — only speed differs.

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;

/// A detected flat-color region, in IMAGE pixel space (caller maps to desktop).
#[napi(object)]
pub struct ColorRegionNative {
    pub color: String,
    pub min_x: u32,
    pub min_y: u32,
    pub max_x: u32,
    pub max_y: u32,
    pub count: u32,
}

/// A detected axis-aligned box, IMAGE space. `parent` is the index of the
/// smallest containing box in the returned vec, or -1 for a root. `depth` is the
/// nesting depth (0 = outermost). TS assembles these into a tree.
#[napi(object)]
pub struct BoxNative {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub edge_score: f64,
    pub depth: i32,
    pub parent: i32,
}

fn parse_hex(color: &str) -> Result<(u8, u8, u8)> {
    let hex = color.trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Invalid color: {color}"),
        ));
    }
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap();
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap();
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap();
    Ok((r, g, b))
}

/// Scan an RGBA frame for the requested flat colors and aggregate a bounding box
/// + pixel count for each. Mirrors `ComputerService.findColorRegions`' inner
/// loop but in native code. This is the hot path used every game tick.
#[napi]
pub fn find_color_regions_raw(
    data: Buffer,
    width: u32,
    height: u32,
    colors: Vec<String>,
    tolerance: Option<u32>,
    sample_step: Option<u32>,
    min_pixels: Option<u32>,
) -> Result<Vec<ColorRegionNative>> {
    let tol = tolerance.unwrap_or(12).min(255) as i32;
    let step = sample_step.unwrap_or(2).max(1);
    let min_px = min_pixels.unwrap_or(20).max(1);
    let w = width as usize;
    let h = height as usize;
    let bytes = data.as_ref();
    if bytes.len() < w * h * 4 {
        return Err(Error::new(
            Status::InvalidArg,
            "RGBA buffer smaller than width*height*4".to_string(),
        ));
    }

    struct Acc {
        color: String,
        r: i32,
        g: i32,
        b: i32,
        count: u32,
        min_x: u32,
        min_y: u32,
        max_x: i64,
        max_y: i64,
    }
    let mut accs: Vec<Acc> = Vec::with_capacity(colors.len());
    for c in &colors {
        let (r, g, b) = parse_hex(c)?;
        accs.push(Acc {
            color: format!("#{:02X}{:02X}{:02X}", r, g, b),
            r: r as i32,
            g: g as i32,
            b: b as i32,
            count: 0,
            min_x: width,
            min_y: height,
            max_x: -1,
            max_y: -1,
        });
    }

    let mut y = 0usize;
    while y < h {
        let mut x = 0usize;
        while x < w {
            let i = (y * w + x) * 4;
            let pr = bytes[i] as i32;
            let pg = bytes[i + 1] as i32;
            let pb = bytes[i + 2] as i32;
            for a in accs.iter_mut() {
                if (pr - a.r).abs() <= tol && (pg - a.g).abs() <= tol && (pb - a.b).abs() <= tol {
                    a.count += 1;
                    if (x as u32) < a.min_x {
                        a.min_x = x as u32;
                    }
                    if (y as u32) < a.min_y {
                        a.min_y = y as u32;
                    }
                    if x as i64 > a.max_x {
                        a.max_x = x as i64;
                    }
                    if y as i64 > a.max_y {
                        a.max_y = y as i64;
                    }
                    break;
                }
            }
            x += step as usize;
        }
        y += step as usize;
    }

    Ok(accs
        .into_iter()
        .filter(|a| a.count >= min_px && a.max_x >= 0)
        .map(|a| ColorRegionNative {
            color: a.color,
            min_x: a.min_x,
            min_y: a.min_y,
            max_x: a.max_x as u32,
            max_y: a.max_y as u32,
            count: a.count,
        })
        .collect())
}

// ── box detection (edge map + rectangle search + nesting) ────────────────────

fn build_edge_map(bytes: &[u8], w: usize, h: usize, threshold: f64) -> Vec<u8> {
    let mut gray = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            gray[y * w + x] = (bytes[i] as f32 * 0.299
                + bytes[i + 1] as f32 * 0.587
                + bytes[i + 2] as f32 * 0.114) as f32;
        }
    }
    let mut edges = vec![0u8; w * h];
    if w < 3 || h < 3 {
        return edges;
    }
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let g = |xx: usize, yy: usize| gray[yy * w + xx];
            let gx = -g(x - 1, y - 1) + g(x + 1, y - 1) - 2.0 * g(x - 1, y) + 2.0 * g(x + 1, y)
                - g(x - 1, y + 1)
                + g(x + 1, y + 1);
            let gy = -g(x - 1, y - 1) - 2.0 * g(x, y - 1) - g(x + 1, y - 1)
                + g(x - 1, y + 1)
                + 2.0 * g(x, y + 1)
                + g(x + 1, y + 1);
            let mag = (gx * gx + gy * gy).sqrt();
            if mag as f64 >= threshold {
                edges[y * w + x] = 1;
            }
        }
    }
    edges
}

fn h_line_score(edges: &[u8], w: usize, h: usize, y: usize, x0: usize, x1: usize) -> f64 {
    let mut hit = 0usize;
    let total = x1 - x0 + 1;
    for x in x0..=x1 {
        let mut on = false;
        for dy in -1i64..=1 {
            let yy = y as i64 + dy;
            if yy >= 0 && (yy as usize) < h && edges[yy as usize * w + x] == 1 {
                on = true;
                break;
            }
        }
        if on {
            hit += 1;
        }
    }
    hit as f64 / total as f64
}

fn v_line_score(edges: &[u8], w: usize, _h: usize, x: usize, y0: usize, y1: usize) -> f64 {
    let mut hit = 0usize;
    let total = y1 - y0 + 1;
    for y in y0..=y1 {
        let mut on = false;
        for dx in -1i64..=1 {
            let xx = x as i64 + dx;
            if xx >= 0 && (xx as usize) < w && edges[y * w + xx as usize] == 1 {
                on = true;
                break;
            }
        }
        if on {
            hit += 1;
        }
    }
    hit as f64 / total as f64
}

fn pick_peaks(score: &[f64], thresh: f64, merge_tol: usize) -> Vec<usize> {
    let idx: Vec<usize> = (0..score.len()).filter(|&i| score[i] >= thresh).collect();
    let mut peaks: Vec<usize> = Vec::new();
    let mut group: Vec<usize> = Vec::new();
    for &i in &idx {
        if group.is_empty() || i - *group.last().unwrap() <= merge_tol {
            group.push(i);
        } else {
            peaks.push(best_of_group(&group, score));
            group = vec![i];
        }
    }
    if !group.is_empty() {
        peaks.push(best_of_group(&group, score));
    }
    peaks
}

fn best_of_group(group: &[usize], score: &[f64]) -> usize {
    let mut best = group[0];
    for &g in group {
        if score[g] > score[best] {
            best = g;
        }
    }
    best
}

#[derive(Clone)]
struct RawBox {
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    score: f64,
}

/// Detect axis-aligned rectangular boxes and return them flattened with a
/// parent index + depth describing the containment hierarchy.
#[napi]
pub fn find_boxes_raw(
    data: Buffer,
    width: u32,
    height: u32,
    edge_threshold: Option<f64>,
    min_size: Option<u32>,
    max_size: Option<u32>,
    min_edge_score: Option<f64>,
    merge_tolerance: Option<u32>,
    max_boxes: Option<u32>,
) -> Result<Vec<BoxNative>> {
    let w = width as usize;
    let h = height as usize;
    let bytes = data.as_ref();
    if bytes.len() < w * h * 4 {
        return Err(Error::new(
            Status::InvalidArg,
            "RGBA buffer smaller than width*height*4".to_string(),
        ));
    }
    let threshold = edge_threshold.unwrap_or(40.0);
    let min_sz = min_size.unwrap_or(12).max(4) as usize;
    let max_w = (max_size.unwrap_or(width) as usize).min(w);
    let max_h = (max_size.unwrap_or(height) as usize).min(h);
    let min_edge = min_edge_score.unwrap_or(0.6);
    let merge_tol = merge_tolerance.unwrap_or(6).max(1) as usize;
    let max_boxes = max_boxes.unwrap_or(200).max(1) as usize;

    let edges = build_edge_map(bytes, w, h, threshold);

    let mut row_score = vec![0f64; h];
    for y in 0..h {
        let mut c = 0usize;
        for x in 0..w {
            if edges[y * w + x] == 1 {
                c += 1;
            }
        }
        row_score[y] = c as f64 / w as f64;
    }
    let mut col_score = vec![0f64; w];
    for x in 0..w {
        let mut c = 0usize;
        for y in 0..h {
            if edges[y * w + x] == 1 {
                c += 1;
            }
        }
        col_score[x] = c as f64 / h as f64;
    }

    let cand_rows = pick_peaks(&row_score, 0.15, merge_tol);
    let cand_cols = pick_peaks(&col_score, 0.15, merge_tol);

    let mut raw: Vec<RawBox> = Vec::new();
    for a in 0..cand_rows.len() {
        for b in (a + 1)..cand_rows.len() {
            let y0 = cand_rows[a];
            let y1 = cand_rows[b];
            if y1 - y0 < min_sz || y1 - y0 > max_h {
                continue;
            }
            for c in 0..cand_cols.len() {
                for d in (c + 1)..cand_cols.len() {
                    let x0 = cand_cols[c];
                    let x1 = cand_cols[d];
                    if x1 - x0 < min_sz || x1 - x0 > max_w {
                        continue;
                    }
                    let top = h_line_score(&edges, w, h, y0, x0, x1);
                    let bottom = h_line_score(&edges, w, h, y1, x0, x1);
                    let left = v_line_score(&edges, w, h, x0, y0, y1);
                    let right = v_line_score(&edges, w, h, x1, y0, y1);
                    if top >= min_edge
                        && bottom >= min_edge
                        && left >= min_edge
                        && right >= min_edge
                    {
                        raw.push(RawBox {
                            x0,
                            y0,
                            x1,
                            y1,
                            score: (top + bottom + left + right) / 4.0,
                        });
                    }
                }
            }
        }
    }

    // Dedupe near-duplicate rectangles, keep best score.
    let mut deduped: Vec<RawBox> = Vec::new();
    for b in raw {
        let mut merged = false;
        for o in deduped.iter_mut() {
            if (o.x0 as i64 - b.x0 as i64).abs() <= merge_tol as i64
                && (o.y0 as i64 - b.y0 as i64).abs() <= merge_tol as i64
                && (o.x1 as i64 - b.x1 as i64).abs() <= merge_tol as i64
                && (o.y1 as i64 - b.y1 as i64).abs() <= merge_tol as i64
            {
                if b.score > o.score {
                    *o = b.clone();
                }
                merged = true;
                break;
            }
        }
        if !merged {
            // manual move because b may have been moved into *o above only when merged
            // (guarded by break); here it's safe.
            deduped.push(b);
        }
    }
    deduped.sort_by(|p, q| q.score.partial_cmp(&p.score).unwrap());
    deduped.truncate(max_boxes);

    // Sort by area desc for nesting, then compute parent (smallest container).
    let mut idxs: Vec<usize> = (0..deduped.len()).collect();
    let area = |b: &RawBox| (b.x1 - b.x0) * (b.y1 - b.y0);
    idxs.sort_by(|&i, &j| area(&deduped[j]).cmp(&area(&deduped[i])));

    let contains = |o: &RawBox, i: &RawBox| -> bool {
        let pad = 2i64;
        i.x0 as i64 >= o.x0 as i64 - pad
            && i.y0 as i64 >= o.y0 as i64 - pad
            && (i.x1 as i64) <= o.x1 as i64 + pad
            && (i.y1 as i64) <= o.y1 as i64 + pad
            && area(i) < area(o)
    };

    let mut out: Vec<BoxNative> = Vec::with_capacity(deduped.len());
    for &i in &idxs {
        let bi = &deduped[i];
        // smallest container among all others
        let mut parent: i32 = -1;
        let mut parent_area = usize::MAX;
        for (oi, &jo) in idxs.iter().enumerate() {
            if jo == i {
                continue;
            }
            let bj = &deduped[jo];
            if contains(bj, bi) && area(bj) < parent_area {
                parent = oi as i32;
                parent_area = area(bj);
            }
        }
        out.push(BoxNative {
            x: bi.x0 as u32,
            y: bi.y0 as u32,
            width: (bi.x1 - bi.x0) as u32,
            height: (bi.y1 - bi.y0) as u32,
            edge_score: bi.score,
            depth: 0,
            parent,
        });
    }
    // depth from parent chain (parent refers to position in `out`, which follows idxs order)
    for k in 0..out.len() {
        let mut d = 0i32;
        let mut p = out[k].parent;
        let mut guard = 0;
        while p >= 0 && guard < out.len() {
            d += 1;
            p = out[p as usize].parent;
            guard += 1;
        }
        out[k].depth = d;
    }
    Ok(out)
}

// ── region detection (foreground / colors / panels segmentation) ─────────────
//
// Native port of the TS `findRegions` (perception.ts). All three modes share a
// connected-components core and a nesting-by-containment step. Returns the same
// flattened `BoxNative` list (parent index + depth) that `find_boxes_raw`
// returns, so the TS layer rebuilds the tree identically for both.

/// A labelled connected component's bounding box + pixel/edge counts.
struct Comp {
    min_x: usize,
    min_y: usize,
    max_x: usize,
    max_y: usize,
    count: usize,
}

/// 4-connectivity connected components over a boolean mask. Mirrors the TS
/// `connectedComponents`.
fn connected_components(mask: &[u8], w: usize, h: usize, min_pixels: usize) -> Vec<Comp> {
    let mut seen = vec![0u8; w * h];
    let mut comps: Vec<Comp> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..(w * h) {
        if mask[start] == 0 || seen[start] != 0 {
            continue;
        }
        let mut min_x = w;
        let mut min_y = h;
        let mut max_x = 0usize;
        let mut max_y = 0usize;
        let mut count = 0usize;
        stack.clear();
        stack.push(start);
        seen[start] = 1;
        while let Some(idx) = stack.pop() {
            let x = idx % w;
            let y = idx / w;
            count += 1;
            if x < min_x {
                min_x = x;
            }
            if y < min_y {
                min_y = y;
            }
            if x > max_x {
                max_x = x;
            }
            if y > max_y {
                max_y = y;
            }
            // 4-neighbours
            if x > 0 {
                let n = idx - 1;
                if mask[n] != 0 && seen[n] == 0 {
                    seen[n] = 1;
                    stack.push(n);
                }
            }
            if x + 1 < w {
                let n = idx + 1;
                if mask[n] != 0 && seen[n] == 0 {
                    seen[n] = 1;
                    stack.push(n);
                }
            }
            if y > 0 {
                let n = idx - w;
                if mask[n] != 0 && seen[n] == 0 {
                    seen[n] = 1;
                    stack.push(n);
                }
            }
            if y + 1 < h {
                let n = idx + w;
                if mask[n] != 0 && seen[n] == 0 {
                    seen[n] = 1;
                    stack.push(n);
                }
            }
        }
        if count >= min_pixels {
            comps.push(Comp {
                min_x,
                min_y,
                max_x,
                max_y,
                count,
            });
        }
    }
    comps
}

/// Grow a boolean mask by `r` px (square structuring element), separable.
/// Mirrors the TS `dilateMask`.
fn dilate_mask(mask: &[u8], w: usize, h: usize, r: usize) -> Vec<u8> {
    let ri = r as i64;
    let mut tmp = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut on = false;
            let mut dx = -ri;
            while dx <= ri && !on {
                let xx = x as i64 + dx;
                if xx >= 0 && (xx as usize) < w && mask[y * w + xx as usize] != 0 {
                    on = true;
                }
                dx += 1;
            }
            if on {
                tmp[y * w + x] = 1;
            }
        }
    }
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut on = false;
            let mut dy = -ri;
            while dy <= ri && !on {
                let yy = y as i64 + dy;
                if yy >= 0 && (yy as usize) < h && tmp[yy as usize * w + x] != 0 {
                    on = true;
                }
                dy += 1;
            }
            if on {
                out[y * w + x] = 1;
            }
        }
    }
    out
}

/// Quantized color key for a pixel (bits per channel). Mirrors the TS
/// `colorSegments` key function.
#[inline]
fn color_key(bytes: &[u8], w: usize, x: usize, y: usize, bits: u32) -> u32 {
    let shift = 8 - bits;
    let i = (y * w + x) * 4;
    let r = (bytes[i] as u32) >> shift;
    let g = (bytes[i + 1] as u32) >> shift;
    let b = (bytes[i + 2] as u32) >> shift;
    (r << (bits * 2)) | (g << bits) | b
}

/// The dominant coarsely-binned color in the frame (4-bit per channel bins),
/// sampled for speed. Mirrors the TS `dominantColor`.
fn dominant_color(bytes: &[u8], w: usize, h: usize) -> (i32, i32, i32) {
    use std::collections::HashMap;
    let total = w * h;
    let step = std::cmp::max(1, total / 200_000);
    let mut bins: HashMap<u32, u32> = HashMap::new();
    let mut i = 0usize;
    while i < total {
        let j = i * 4;
        let key = (((bytes[j] as u32) >> 4) << 8)
            | (((bytes[j + 1] as u32) >> 4) << 4)
            | ((bytes[j + 2] as u32) >> 4);
        *bins.entry(key).or_insert(0) += 1;
        i += step;
    }
    let mut best_key = 0u32;
    let mut best_n = 0u32;
    for (&k, &n) in bins.iter() {
        if n > best_n {
            best_n = n;
            best_key = k;
        }
    }
    let r = (((best_key >> 8) & 0xf) * 16 + 8) as i32;
    let g = (((best_key >> 4) & 0xf) * 16 + 8) as i32;
    let b = ((best_key & 0xf) * 16 + 8) as i32;
    (r, g, b)
}

/// Connected components where adjacency requires the SAME quantized color.
/// Mirrors the TS `colorSegments`.
fn color_segments(bytes: &[u8], w: usize, h: usize, bits: u32, min_pixels: usize) -> Vec<Comp> {
    let mut seen = vec![0u8; w * h];
    let mut comps: Vec<Comp> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..(w * h) {
        if seen[start] != 0 {
            continue;
        }
        let sx = start % w;
        let sy = start / w;
        let k = color_key(bytes, w, sx, sy, bits);
        let mut min_x = w;
        let mut min_y = h;
        let mut max_x = 0usize;
        let mut max_y = 0usize;
        let mut count = 0usize;
        stack.clear();
        stack.push(start);
        seen[start] = 1;
        while let Some(idx) = stack.pop() {
            let x = idx % w;
            let y = idx / w;
            count += 1;
            if x < min_x {
                min_x = x;
            }
            if y < min_y {
                min_y = y;
            }
            if x > max_x {
                max_x = x;
            }
            if y > max_y {
                max_y = y;
            }
            let push_if = |n: usize, seen: &mut [u8], stack: &mut Vec<usize>| {
                if seen[n] == 0 {
                    let nx = n % w;
                    let ny = n / w;
                    if color_key(bytes, w, nx, ny, bits) == k {
                        seen[n] = 1;
                        stack.push(n);
                    }
                }
            };
            if x > 0 {
                push_if(idx - 1, &mut seen, &mut stack);
            }
            if x + 1 < w {
                push_if(idx + 1, &mut seen, &mut stack);
            }
            if y > 0 {
                push_if(idx - w, &mut seen, &mut stack);
            }
            if y + 1 < h {
                push_if(idx + w, &mut seen, &mut stack);
            }
        }
        if count >= min_pixels {
            comps.push(Comp {
                min_x,
                min_y,
                max_x,
                max_y,
                count,
            });
        }
    }
    comps
}

/// Mark out[i]=1 for pixels in component bbox that match the component's
/// center color key. Mirrors the TS `markComponentPixels`.
fn mark_component_pixels(bytes: &[u8], w: usize, bits: u32, c: &Comp, out: &mut [u8]) {
    // Match the TS `markComponentPixels` center = round((min+max)/2), clamped.
    let cx = (((c.min_x + c.max_x) as f64 / 2.0).round() as usize).clamp(c.min_x, c.max_x);
    let cy = (((c.min_y + c.max_y) as f64 / 2.0).round() as usize).clamp(c.min_y, c.max_y);
    let k = color_key(bytes, w, cx, cy, bits);
    for y in c.min_y..=c.max_y {
        for x in c.min_x..=c.max_x {
            if color_key(bytes, w, x, y, bits) == k {
                out[y * w + x] = 1;
            }
        }
    }
}

/// "Panels" segmentation: large flat same-color areas become background
/// SURFACES; the remaining foreground content is dilated + clustered. Mirrors
/// the TS `panelSegments`. Returns [surfaces..., clusters...].
fn panel_segments(
    bytes: &[u8],
    w: usize,
    h: usize,
    bits: u32,
    min_pixels: usize,
    cluster_gap: usize,
    bg_area_frac: f64,
) -> Vec<Comp> {
    let color_comps = color_segments(bytes, w, h, bits, std::cmp::max(1, min_pixels));
    let frame_area = (w * h) as f64;
    let min_surface_area =
        std::cmp::max(min_pixels * 4, (frame_area * bg_area_frac).round() as usize);
    let mut surfaces: Vec<Comp> = Vec::new();
    let mut is_surface = vec![0u8; w * h];
    for c in color_comps.into_iter() {
        let bw = c.max_x - c.min_x + 1;
        let bh = c.max_y - c.min_y + 1;
        let area = bw * bh;
        let fill = c.count as f64 / std::cmp::max(1, area) as f64;
        if c.count >= min_surface_area && fill >= 0.5 {
            mark_component_pixels(bytes, w, bits, &c, &mut is_surface);
            surfaces.push(c);
        }
    }
    let mut fg_base = vec![0u8; w * h];
    for i in 0..(w * h) {
        fg_base[i] = if is_surface[i] != 0 { 0 } else { 1 };
    }
    let fg = if cluster_gap > 0 {
        dilate_mask(&fg_base, w, h, cluster_gap)
    } else {
        fg_base
    };
    let clusters = connected_components(&fg, w, h, std::cmp::max(1, min_pixels));
    let mut out = surfaces;
    out.extend(clusters);
    out
}

/// Detect UI regions/elements by segmentation, returning a flattened box list
/// (parent index + depth) — the native port of TS `findRegions`. `mode`:
/// "foreground" (default) | "colors" | "panels".
#[napi]
pub fn find_regions_raw(
    data: Buffer,
    width: u32,
    height: u32,
    mode: Option<String>,
    bg_tolerance: Option<u32>,
    min_size: Option<u32>,
    max_size_frac: Option<f64>,
    min_pixels: Option<u32>,
    max_boxes: Option<u32>,
    dilate: Option<u32>,
    color_bits: Option<u32>,
    cluster_gap: Option<u32>,
    bg_area_frac: Option<f64>,
) -> Result<Vec<BoxNative>> {
    let w = width as usize;
    let h = height as usize;
    let bytes = data.as_ref();
    if bytes.len() < w * h * 4 {
        return Err(Error::new(
            Status::InvalidArg,
            "RGBA buffer smaller than width*height*4".to_string(),
        ));
    }
    let mode = mode.unwrap_or_else(|| "foreground".to_string());
    let bg_tol = bg_tolerance.unwrap_or(18).min(255) as i32;
    let min_size = std::cmp::max(2, min_size.unwrap_or(16)) as usize;
    let max_size_frac = max_size_frac.unwrap_or(0.98);
    let min_px = std::cmp::max(1, min_pixels.unwrap_or(40)) as usize;
    let max_boxes = std::cmp::max(1, max_boxes.unwrap_or(300)) as usize;
    let dilate = dilate.unwrap_or(3) as usize;
    let bits = color_bits.unwrap_or(3).clamp(1, 8);

    let comps: Vec<Comp> = match mode.as_str() {
        "panels" => panel_segments(
            bytes,
            w,
            h,
            bits,
            min_px,
            cluster_gap.unwrap_or(3) as usize,
            bg_area_frac.unwrap_or(0.004),
        ),
        "colors" => color_segments(bytes, w, h, bits, min_px),
        _ => {
            // foreground = NOT dominant background color
            let (br, bg, bb) = dominant_color(bytes, w, h);
            let mut mask = vec![0u8; w * h];
            for y in 0..h {
                for x in 0..w {
                    let i = (y * w + x) * 4;
                    let pr = bytes[i] as i32;
                    let pg = bytes[i + 1] as i32;
                    let pb = bytes[i + 2] as i32;
                    if !((pr - br).abs() <= bg_tol
                        && (pg - bg).abs() <= bg_tol
                        && (pb - bb).abs() <= bg_tol)
                    {
                        mask[y * w + x] = 1;
                    }
                }
            }
            let mask = if dilate > 0 {
                dilate_mask(&mask, w, h, dilate)
            } else {
                mask
            };
            connected_components(&mask, w, h, min_px)
        }
    };

    let max_w = w as f64 * max_size_frac;
    let max_h = h as f64 * max_size_frac;

    // Turn eligible components into raw boxes with a fill "score".
    struct RegBox {
        x0: usize,
        y0: usize,
        x1: usize,
        y1: usize,
        score: f64,
    }
    let mut boxes: Vec<RegBox> = Vec::new();
    for c in comps.iter() {
        let bw = c.max_x - c.min_x;
        let bh = c.max_y - c.min_y;
        if bw < min_size || bh < min_size {
            continue;
        }
        if (bw as f64) > max_w || (bh as f64) > max_h {
            continue;
        }
        let fill = c.count as f64 / std::cmp::max(1, bw * bh) as f64;
        boxes.push(RegBox {
            x0: c.min_x,
            y0: c.min_y,
            x1: c.max_x,
            y1: c.max_y,
            score: fill,
        });
    }
    // Sort by area desc and cap.
    let area = |b: &RegBox| (b.x1 - b.x0) * (b.y1 - b.y0);
    boxes.sort_by(|a, b| area(b).cmp(&area(a)));
    boxes.truncate(max_boxes);

    // Nest by containment (smallest container = parent), mirroring nestBoxes.
    let idxs: Vec<usize> = (0..boxes.len()).collect();
    let contains = |o: &RegBox, i: &RegBox| -> bool {
        let pad = 2i64;
        i.x0 as i64 >= o.x0 as i64 - pad
            && i.y0 as i64 >= o.y0 as i64 - pad
            && (i.x1 as i64) <= o.x1 as i64 + pad
            && (i.y1 as i64) <= o.y1 as i64 + pad
            && area(i) < area(o)
    };
    let mut out: Vec<BoxNative> = Vec::with_capacity(boxes.len());
    for &i in &idxs {
        let bi = &boxes[i];
        let mut parent: i32 = -1;
        let mut parent_area = usize::MAX;
        for (oi, &jo) in idxs.iter().enumerate() {
            if jo == i {
                continue;
            }
            let bj = &boxes[jo];
            if contains(bj, bi) && area(bj) < parent_area {
                parent = oi as i32;
                parent_area = area(bj);
            }
        }
        out.push(BoxNative {
            x: bi.x0 as u32,
            y: bi.y0 as u32,
            width: (bi.x1 - bi.x0) as u32,
            height: (bi.y1 - bi.y0) as u32,
            edge_score: bi.score,
            depth: 0,
            parent,
        });
    }
    for k in 0..out.len() {
        let mut d = 0i32;
        let mut p = out[k].parent;
        let mut guard = 0;
        while p >= 0 && guard < out.len() {
            d += 1;
            p = out[p as usize].parent;
            guard += 1;
        }
        out[k].depth = d;
    }
    Ok(out)
}
