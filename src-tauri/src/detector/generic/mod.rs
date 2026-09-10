// Generic, family-agnostic heuristic scanner for "potential maps".
//
// The per-family detectors under detector/ecu/ anchor on the structural
// signatures of a KNOWN ECU and are held to a zero-false-positive bar: the app
// refuses a file it cannot positively identify rather than risk showing a
// wrong map. This scanner is the opposite tool, for the opposite situation: a
// file the identifier does NOT recognize. It makes no assumption about the ECU
// and walks the whole binary looking for the structural shape shared by almost
// every Bosch calibration table:
//
//     [ Y axis : `rows` non-decreasing words ]
//     [ X axis : `cols` non-decreasing words ]
//     [ data   : rows*cols words             ]
//
// Two monotonic axes back-to-back, immediately followed by a data block of the
// matching length, are a strong (low-false-positive) signal that survives on
// files from ECUs the app has no detector for.
//
// Word width and byte order are NOT assumed. The scanner tries 16-bit
// big-endian AND little-endian and keeps whichever byte order yields more
// candidates (real axes read as clean monotonic breakpoints in the correct
// endianness and as noise in the wrong one); it then makes a second 8-bit pass
// in that same byte order, since a large share of real tables are 8-bit. This
// is what lets it work on the little-endian families (EDC17, MD1, ...) the app
// has no detector for -- earlier it was hard-wired to 16-bit big-endian and
// found almost none of their maps.
//
// The results are CANDIDATES, not trusted maps. They are named
// "Potential map @0x...", carry a low confidence and the category
// "Potential maps", and expose raw (unconverted) values -- no invented unit or
// factor. They are meant to be surfaced only as highlighted regions in the
// hexdump so the user can inspect them; they are deliberately kept out of the
// trusted map list, the completeness report and the mappack export.

use crate::models::{DataType, DetectedMap, MapDimensions};

/// Candidate 2D table geometry. `rows` is the first (Y) axis, `cols` the second
/// (X) axis, matching the real Bosch `[Y][X][data]` layout. The cap was raised
/// from 32 to 64 because real maps go wider than 32 (e.g. 40-column BMW tables).
const MIN_ROWS: usize = 2;
const MAX_ROWS: usize = 64;
const MIN_COLS: usize = 4;
const MAX_COLS: usize = 64;

/// 1D curve axis length limits -- kept longer than the 2D column minimum so a
/// stray short ramp is not mistaken for a curve.
const MIN_CURVE_LEN: usize = 8;
const MAX_CURVE_LEN: usize = 64;

/// Hard cap on the number of candidates, so a pathological file cannot flood
/// the hexdump (and the stored project) with thousands of regions. Raised to
/// 1000 because a 2MB EDC17 dump carries more real maps than the old 400 cap
/// could surface.
const MAX_CANDIDATES: usize = 1000;

/// Confidence reported on candidates: low on purpose. These are guesses, and
/// the UI treats them as such. 1D curves are the weaker signal of the two, and
/// 8-bit tables weaker than 16-bit (a byte axis is far more common by chance).
const CANDIDATE_CONFIDENCE_2D: f32 = 0.25;
const CANDIDATE_CONFIDENCE_1D: f32 = 0.18;
const CONFIDENCE_8BIT_PENALTY: f32 = 0.05;

/// Value word width searched. 8-bit values have no byte order; 16-bit do.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Width {
    Bits8,
    Bits16,
}

/// Byte order for multi-byte words.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Endian {
    Big,
    Little,
}

impl Width {
    /// Bytes per word -- also the address stride between consecutive words.
    fn stride(self) -> usize {
        match self {
            Width::Bits8 => 1,
            Width::Bits16 => 2,
        }
    }
    /// The flash-fill / top sentinel value for this width.
    fn max_val(self) -> u32 {
        match self {
            Width::Bits8 => 0xFF,
            Width::Bits16 => 0xFFFF,
        }
    }
    fn data_type(self) -> DataType {
        match self {
            Width::Bits8 => DataType::UInt8,
            Width::Bits16 => DataType::UInt16,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Width::Bits8 => "8-bit",
            Width::Bits16 => "16-bit",
        }
    }
}

/// Decode the binary into word values (widened to u32 so 8- and 16-bit share a
/// path). `stride`-aligned; a trailing partial word is dropped.
fn read_words(data: &[u8], endian: Endian, width: Width) -> Vec<u32> {
    match width {
        Width::Bits8 => data.iter().map(|&b| b as u32).collect(),
        Width::Bits16 => {
            let n = data.len() / 2;
            let mut words = Vec::with_capacity(n);
            for i in 0..n {
                let (hi, lo) = (data[i * 2] as u32, data[i * 2 + 1] as u32);
                words.push(match endian {
                    Endian::Big => (hi << 8) | lo,
                    Endian::Little => (lo << 8) | hi,
                });
            }
            words
        }
    }
}

/// Length of the axis run starting at `start`, capped at `max`: a
/// strictly-increasing core, then any trailing repeats of the final value.
///
/// The strictly-increasing core keeps axis boundaries clean and, crucially,
/// does NOT run through a flat padding region (equal words), so leading padding
/// is skipped rather than swallowed. The trailing-repeat tail still captures the
/// one relaxation the `.ols` corpus showed is real -- an axis that repeats its
/// saturated endpoint -- without the false positives a fully non-decreasing run
/// would admit.
fn axis_run(words: &[u32], start: usize, max: usize) -> usize {
    let mut len = 1;
    while start + len < words.len() && len < max && words[start + len] > words[start + len - 1] {
        len += 1;
    }
    while start + len < words.len() && len < max && words[start + len] == words[start + len - 1] {
        len += 1;
    }
    len
}

fn is_nondecreasing(d: &[u32]) -> bool {
    d.windows(2).all(|w| w[1] >= w[0])
}

/// A plausible axis genuinely trends upward: it is not flash-fill-topped, its
/// last value exceeds its first, and a majority of its steps actually increase
/// (so a mostly-flat run admitted by the trailing-repeat relaxation is rejected).
fn plausible_axis(axis: &[u32], max_val: u32) -> bool {
    let len = axis.len();
    if len < 2 {
        return false;
    }
    let (first, last) = (axis[0], axis[len - 1]);
    if last >= max_val || last <= first {
        return false;
    }
    let up_steps = axis.windows(2).filter(|w| w[1] > w[0]).count();
    // At least half the adjacent pairs strictly increase.
    up_steps * 2 >= len - 1
}

/// A data block that is uniform, or dominated by flash-fill words (0 / max), is
/// padding or an unrelated constant region -- not a map.
fn plausible_data(d: &[u32], max_val: u32) -> bool {
    let first = d[0];
    if d.iter().all(|&x| x == first) {
        return false;
    }
    let padding = d.iter().filter(|&&x| x == 0 || x == max_val).count();
    // Reject when 80% or more of the block is flash-fill.
    padding * 100 < d.len() * 80
}

/// Context for one (endianness, width) scan pass.
struct ScanCtx {
    words: Vec<u32>,
    stride: usize,
    max_val: u32,
    data_type: DataType,
    width: Width,
    /// Byte offset of `words[0]` within the original file, so addresses come out
    /// absolute even when only a sub-range of the file is scanned.
    base: u32,
}

impl ScanCtx {
    fn addr(&self, word_index: usize) -> u32 {
        self.base + (word_index * self.stride) as u32
    }

    /// Try to read a candidate table whose Y axis starts at word index `w`.
    /// On success returns the word index just past the whole structure (so the
    /// caller can resume without re-emitting overlapping candidates) and the map.
    fn try_table_at(&self, w: usize) -> Option<(usize, DetectedMap)> {
        let words = &self.words;
        // Y axis (first block, per the real Bosch [Y][X][data] layout).
        let rows = axis_run(words, w, MAX_ROWS);
        if !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
            return None;
        }
        let x_start = w + rows;

        // X axis -- a fresh run right after the Y axis. The Y run ended because
        // the sequence dropped, so this is a genuine new axis.
        let cols = axis_run(words, x_start, MAX_COLS);
        if !(MIN_COLS..=MAX_COLS).contains(&cols) {
            return None;
        }
        let data_start = x_start + cols;
        let count = rows * cols;
        if data_start + count > words.len() {
            return None;
        }

        if !plausible_axis(&words[w..x_start], self.max_val)
            || !plausible_axis(&words[x_start..data_start], self.max_val)
        {
            return None;
        }
        let block = &words[data_start..data_start + count];
        if !plausible_data(block, self.max_val) {
            return None;
        }
        // A "data" block that is itself non-decreasing is far more likely another
        // axis / lookup / pointer table than a real map.
        if is_nondecreasing(block) {
            return None;
        }

        let y_axis_addr = self.addr(w);
        let x_axis_addr = self.addr(x_start);
        let data_addr = self.addr(data_start);

        let mut map = DetectedMap::new(
            data_addr,
            count * self.stride,
            MapDimensions::TwoDimensional { rows, cols },
            self.data_type.clone(),
        );
        map.name = Some(format!("Potential map @0x{:X}", data_addr));
        map.category = Some("Potential maps".to_string());
        map.confidence = CANDIDATE_CONFIDENCE_2D - self.width_penalty();
        map.x_axis_address = Some(x_axis_addr);
        map.y_axis_address = Some(y_axis_addr);
        map.description = Some(format!(
            "Heuristically detected candidate table ({}x{}, unverified) -- raw {} values, inspect in the hexdump",
            rows,
            cols,
            self.width.label()
        ));

        Some((data_start + count, map))
    }

    /// Try to read a candidate 1D curve (single axis + data of equal length)
    /// whose axis starts at word index `w`. Only attempted when the 2D shape
    /// failed, so a real table's axis is not re-emitted as a curve.
    fn try_curve_at(&self, w: usize) -> Option<(usize, DetectedMap)> {
        let words = &self.words;
        let len = axis_run(words, w, MAX_CURVE_LEN);
        if !(MIN_CURVE_LEN..=MAX_CURVE_LEN).contains(&len) {
            return None;
        }
        let data_start = w + len;
        if data_start + len > words.len() {
            return None;
        }
        if !plausible_axis(&words[w..data_start], self.max_val) {
            return None;
        }
        let block = &words[data_start..data_start + len];
        if !plausible_data(block, self.max_val) {
            return None;
        }
        // If the "data" starts with its own long increasing run it is really the
        // X axis of a 2D table (whose Y axis this "curve" is), not curve data.
        if axis_run(block, 0, MIN_COLS) >= MIN_COLS {
            return None;
        }
        // If the "data" is itself non-decreasing, this is two axes (or a
        // lookup), not a curve.
        if is_nondecreasing(block) {
            return None;
        }

        let axis_addr = self.addr(w);
        let data_addr = self.addr(data_start);

        let mut map = DetectedMap::new(
            data_addr,
            len * self.stride,
            MapDimensions::OneDimensional { length: len },
            self.data_type.clone(),
        );
        map.name = Some(format!("Potential curve @0x{:X}", data_addr));
        map.category = Some("Potential maps".to_string());
        map.confidence = CANDIDATE_CONFIDENCE_1D - self.width_penalty();
        map.x_axis_address = Some(axis_addr);
        map.description = Some(format!(
            "Heuristically detected candidate curve ({} points, unverified) -- raw {} values, inspect in the hexdump",
            len,
            self.width.label()
        ));

        Some((data_start + len, map))
    }

    fn width_penalty(&self) -> f32 {
        if self.width == Width::Bits8 {
            CONFIDENCE_8BIT_PENALTY
        } else {
            0.0
        }
    }

    /// Walk the whole word buffer, emitting candidates and resuming past each
    /// matched structure. Returns at most `MAX_CANDIDATES` maps.
    fn scan(&self) -> Vec<DetectedMap> {
        let words = &self.words;
        let n = words.len();
        let mut out: Vec<DetectedMap> = Vec::new();
        let mut w = 0usize;
        while w + MIN_ROWS + MIN_COLS < n {
            if out.len() >= MAX_CANDIDATES {
                break;
            }
            // Do not start an axis in the middle of a flat region: block /
            // flash padding is exactly such a plateau, and starting there lets a
            // trailing pad word bridge into the following axis, shifting the map
            // by one and masking it. A genuine axis start follows a drop.
            if w > 0 && words[w - 1] == words[w] {
                w += 1;
                continue;
            }
            // Prefer the stronger 2D signal; fall back to a 1D curve at the same
            // offset only when no table matched.
            if let Some((end_word, map)) = self.try_table_at(w) {
                out.push(map);
                w = end_word; // resume past the whole structure -- no overlaps
            } else if let Some((end_word, map)) = self.try_curve_at(w) {
                out.push(map);
                w = end_word;
            } else {
                w += 1;
            }
        }
        out
    }
}

fn make_ctx(data: &[u8], endian: Endian, width: Width, base: u32) -> ScanCtx {
    ScanCtx {
        words: read_words(data, endian, width),
        stride: width.stride(),
        max_val: width.max_val(),
        data_type: width.data_type(),
        width,
        base,
    }
}

/// Byte span [start, end) a candidate occupies (axes + data), used to reject
/// an 8-bit candidate that overlaps a 16-bit one already accepted.
fn map_span(m: &DetectedMap) -> (u32, u32) {
    let start = m
        .x_axis_address
        .unwrap_or(m.address)
        .min(m.y_axis_address.unwrap_or(m.address))
        .min(m.address);
    (start, m.address + m.size as u32)
}

fn spans_overlap(a: (u32, u32), b: (u32, u32)) -> bool {
    a.0 < b.1 && b.0 < a.1
}

/// Scan a binary for candidate maps, byte-order- and width-agnostic.
///
/// 1. Scan 16-bit in both byte orders and keep whichever finds more (16-bit is
///    the dominant real format, so it is the right tiebreaker for endianness).
/// 2. Make an 8-bit pass in that same byte order and add candidates that do not
///    overlap the 16-bit ones, up to the global cap.
pub fn scan_potential_maps(data: &[u8]) -> Vec<DetectedMap> {
    scan_slice(data, 0)
}

/// Scan only the byte range `[start, end)` of `data`, returning candidates with
/// absolute (whole-file) addresses. Used by the "re-scan the map area" button so
/// the leading code region and trailing flash-fill can be skipped -- see
/// [`map_area_for`]. `start`/`end` are clamped to the file and to each other.
pub fn scan_potential_maps_in_range(data: &[u8], start: usize, end: usize) -> Vec<DetectedMap> {
    let start = start.min(data.len());
    let end = end.min(data.len()).max(start);
    log::warn!(
        "🔎 [generic-scan] map-area range 0x{:X}..0x{:X} ({} of {} bytes)",
        start,
        end,
        end - start,
        data.len()
    );
    scan_slice(&data[start..end], start as u32)
}

/// Length of the file with its trailing flash-fill removed: the run of identical
/// 0x00 / 0xFF bytes at the very end. Returns the index one past the last
/// meaningful byte. A short trailing run of 0/0xFF is NOT treated as fill (a real
/// map can simply end on such a value), so only a substantial pad is trimmed.
fn trim_trailing_fill(data: &[u8]) -> usize {
    let n = data.len();
    let mut end = n;
    while end > 0 && (data[end - 1] == 0xFF || data[end - 1] == 0x00) {
        end -= 1;
    }
    if n - end >= 256 {
        end
    } else {
        n
    }
}

/// Resolve the `[start, end)` byte range that holds the calibration / MAP area
/// for a given ECU family, per the "skip the code region, scan the rest"
/// heuristic: skip a leading program/code region and stop before the trailing
/// flash-fill. Family unknown -> scan from the start (fill still trimmed).
///
/// `ecu_type` is the frontend family string (e.g. "EDC17C"). For the BMW/PSA
/// EDC17 family the OS/code occupies the low half of the flash and the
/// calibration data & maps live in the upper region (real EDC17C50 maps begin
/// around 0x100000 on a 2 MB dump), so the low half is skipped.
pub fn map_area_for(ecu_type: &str, data: &[u8]) -> (usize, usize) {
    let end = trim_trailing_fill(data);
    let start = match ecu_type {
        "EDC17C" | "EDC17" => data.len() / 2,
        _ => 0,
    };
    (start.min(end), end)
}

/// Core scan over a byte slice whose first byte sits at absolute offset `base`.
fn scan_slice(data: &[u8], base: u32) -> Vec<DetectedMap> {
    if data.len() < 64 {
        return Vec::new();
    }

    let be16 = make_ctx(data, Endian::Big, Width::Bits16, base).scan();
    let le16 = make_ctx(data, Endian::Little, Width::Bits16, base).scan();
    let (chosen_endian, mut out) = if le16.len() > be16.len() {
        (Endian::Little, le16)
    } else {
        (Endian::Big, be16)
    };
    out.truncate(MAX_CANDIDATES);

    // Second pass: 8-bit tables in the chosen byte order, filling remaining
    // budget with regions the 16-bit pass did not already cover.
    if out.len() < MAX_CANDIDATES {
        let mut ranges: Vec<(u32, u32)> = out.iter().map(map_span).collect();
        for m in make_ctx(data, chosen_endian, Width::Bits8, base).scan() {
            if out.len() >= MAX_CANDIDATES {
                break;
            }
            let span = map_span(&m);
            if ranges.iter().any(|&r| spans_overlap(r, span)) {
                continue;
            }
            ranges.push(span);
            out.push(m);
        }
    }

    log::warn!(
        "🔎 [generic-scan] {} candidate table(s) found ({} byte order)",
        out.len(),
        match chosen_endian {
            Endian::Big => "big-endian",
            Endian::Little => "little-endian",
        }
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A data block that alternates a high then a low value: it is non-uniform
    /// (passes the data plausibility test) but has no increasing run longer than
    /// two, so it cannot masquerade as an axis in EITHER byte order or width --
    /// which keeps these tiny single-map buffers from fooling the endianness
    /// tiebreaker or the 8-bit/16-bit overlap dedup.
    fn zigzag16(first: u16, count: usize, out: &mut Vec<u16>) {
        for i in 0..count {
            out.push(if i == 0 {
                first
            } else if i % 2 == 1 {
                0x4000
            } else {
                0x3000
            });
        }
    }

    /// Build a buffer in the real [Y-axis][X-axis][data] layout: `pad` filler
    /// words, then Y axis (`rows`), X axis (`cols`), zig-zag data. The first data
    /// word is forced below the X-axis range so the axis run drops into the data
    /// (how the scanner finds the axis/data boundary). Big- or little-endian.
    fn build(rows: usize, cols: usize, pad: usize, endian: Endian) -> Vec<u8> {
        let mut words: Vec<u16> = Vec::new();
        for _ in 0..pad {
            words.push(0x0000);
        }
        for r in 0..rows {
            words.push(500 + (r as u16) * 250); // Y axis
        }
        for c in 0..cols {
            words.push((c as u16) * 100); // X axis (drops below Y last)
        }
        zigzag16(50, rows * cols, &mut words); // data, first word below X range
        let mut bytes = Vec::with_capacity(words.len() * 2);
        for word in words {
            match endian {
                Endian::Big => {
                    bytes.push((word >> 8) as u8);
                    bytes.push((word & 0xFF) as u8);
                }
                Endian::Little => {
                    bytes.push((word & 0xFF) as u8);
                    bytes.push((word >> 8) as u8);
                }
            }
        }
        bytes
    }

    /// 8-bit analogue of `build`: single-byte Y axis, X axis and zig-zag data.
    fn build8(rows: usize, cols: usize, pad: usize) -> Vec<u8> {
        let mut bytes: Vec<u8> = vec![0u8; pad];
        for r in 0..rows {
            bytes.push(20 + (r as u8) * 10); // Y axis
        }
        for c in 0..cols {
            bytes.push((c as u8) * 5); // X axis (drops below Y last)
        }
        for i in 0..(rows * cols) {
            bytes.push(if i == 0 {
                3
            } else if i % 2 == 1 {
                0x50
            } else {
                0x40
            });
        }
        bytes.extend(std::iter::repeat(0u8).take(pad));
        bytes
    }

    // --- core matcher, tested per (endian, width) without the tiebreaker ---

    #[test]
    fn detects_big_endian_table() {
        let buf = build(16, 10, 32, Endian::Big);
        let maps = make_ctx(&buf, Endian::Big, Width::Bits16, 0).scan();
        assert!(
            maps.iter().any(|m| matches!(
                m.dimensions,
                MapDimensions::TwoDimensional { rows: 16, cols: 10 }
            )),
            "expected the planted 16(rows)x10(cols) BE table, got {} maps",
            maps.len()
        );
    }

    #[test]
    fn detects_little_endian_table() {
        // The old scanner was 16-bit BE only and read this as noise.
        let buf = build(16, 10, 32, Endian::Little);
        let maps = make_ctx(&buf, Endian::Little, Width::Bits16, 0).scan();
        assert!(
            maps.iter().any(|m| matches!(
                m.dimensions,
                MapDimensions::TwoDimensional { rows: 16, cols: 10 }
            )),
            "expected the planted little-endian table, got {} maps",
            maps.len()
        );
    }

    #[test]
    fn detects_8bit_table() {
        let buf = build8(6, 8, 40);
        let maps = make_ctx(&buf, Endian::Big, Width::Bits8, 0).scan();
        assert!(
            maps.iter().any(|m| matches!(
                m.dimensions,
                MapDimensions::TwoDimensional { rows: 6, cols: 8 }
            ) && matches!(m.data_type, DataType::UInt8)),
            "expected the planted 8-bit table, got {} maps",
            maps.len()
        );
    }

    // --- end-to-end: endianness auto-detect picks the byte order with more maps ---

    #[test]
    fn autodetects_big_endian() {
        let mut buf = build(16, 10, 32, Endian::Big);
        buf.extend(build(12, 8, 4, Endian::Big)); // two clean BE tables
        let maps = scan_potential_maps(&buf);
        assert!(
            maps.iter().any(|m| matches!(
                m.dimensions,
                MapDimensions::TwoDimensional { rows: 16, cols: 10 }
            )),
            "auto-detect should keep the BE tables, got {} maps",
            maps.len()
        );
    }

    #[test]
    fn autodetects_little_endian() {
        let mut buf = build(16, 10, 32, Endian::Little);
        buf.extend(build(12, 8, 4, Endian::Little)); // two clean LE tables
        let maps = scan_potential_maps(&buf);
        assert!(
            maps.iter().any(|m| matches!(
                m.dimensions,
                MapDimensions::TwoDimensional { rows: 16, cols: 10 }
            )),
            "auto-detect should keep the LE tables, got {} maps",
            maps.len()
        );
    }

    #[test]
    fn eight_bit_pass_runs_end_to_end() {
        let buf = build8(6, 8, 40);
        let maps = scan_potential_maps(&buf);
        assert!(
            maps.iter().any(|m| matches!(
                m.dimensions,
                MapDimensions::TwoDimensional { rows: 6, cols: 8 }
            ) && matches!(m.data_type, DataType::UInt8)),
            "expected the 8-bit pass to surface the planted byte table, got {} maps",
            maps.len()
        );
    }

    // --- invariants ---

    // --- range-limited (map-area) scan ---

    #[test]
    fn range_scan_offsets_addresses_to_absolute() {
        // A table planted after a leading region: scanning only the tail range
        // must still report whole-file (absolute) addresses.
        let lead = vec![0u8; 4096];
        let table = build(16, 10, 0, Endian::Little);
        let mut buf = lead.clone();
        buf.extend(&table);

        let ranged = scan_potential_maps_in_range(&buf, lead.len(), buf.len());
        let m = ranged
            .iter()
            .find(|m| matches!(
                m.dimensions,
                MapDimensions::TwoDimensional { rows: 16, cols: 10 }
            ))
            .expect("planted table not found in ranged scan");
        // Its Y axis is at the very start of the appended table, i.e. lead.len().
        assert_eq!(m.y_axis_address.unwrap() as usize, lead.len());
        // The name embeds the absolute data address, not a slice-relative one.
        assert!(m
            .name
            .as_deref()
            .unwrap()
            .contains(&format!("{:X}", m.address)));
    }

    #[test]
    fn range_scan_skips_out_of_range_tables() {
        // A table in the leading region is NOT reported when the range starts
        // after it.
        let table = build(16, 10, 0, Endian::Little);
        let mut buf = table.clone();
        buf.extend(vec![0u8; 4096]);
        let ranged = scan_potential_maps_in_range(&buf, table.len(), buf.len());
        assert!(
            ranged.is_empty(),
            "table before the range must not be reported, got {}",
            ranged.len()
        );
    }

    #[test]
    fn map_area_skips_edc17_code_half_and_trailing_fill() {
        let mut data = vec![0xAAu8; 0x100000]; // 1 MB "code"
        data.extend(vec![0x11u8; 0x80000]); // 0.5 MB "data"
        data.extend(vec![0xFFu8; 0x80000]); // 0.5 MB trailing flash-fill
        let (start, end) = map_area_for("EDC17C", &data);
        assert_eq!(start, data.len() / 2, "should skip the low (code) half");
        assert_eq!(end, 0x180000, "should stop before the trailing fill");
    }

    #[test]
    fn map_area_unknown_family_scans_from_start() {
        let data = vec![0x11u8; 4096];
        let (start, end) = map_area_for("SomethingElse", &data);
        assert_eq!(start, 0);
        assert_eq!(end, data.len());
    }

    #[test]
    fn ignores_uniform_fill() {
        // 4 KB of 0xFF flash fill -- no axes, no data, must yield nothing.
        assert!(scan_potential_maps(&vec![0xFFu8; 4096]).is_empty());
    }

    #[test]
    fn ignores_all_zero() {
        assert!(scan_potential_maps(&vec![0x00u8; 4096]).is_empty());
    }

    #[test]
    fn candidate_has_axes_and_category() {
        let buf = build(8, 8, 0, Endian::Big);
        let maps = make_ctx(&buf, Endian::Big, Width::Bits16, 0).scan();
        let m = maps
            .iter()
            .find(|m| matches!(
                m.dimensions,
                MapDimensions::TwoDimensional { rows: 8, cols: 8 }
            ))
            .expect("planted 8x8 table not found");
        assert!(m.x_axis_address.is_some());
        assert!(m.y_axis_address.is_some());
        // Real Bosch layout: the Y axis comes before the X axis in the file.
        assert!(m.y_axis_address.unwrap() < m.x_axis_address.unwrap());
        assert_eq!(m.category.as_deref(), Some("Potential maps"));
        assert!(m.confidence > 0.0 && m.confidence < 0.5);
    }
}
