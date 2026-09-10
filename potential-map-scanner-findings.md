# Findings: improving ZedSuite's "potential maps" scanner using WinOLS `.ols` data

**Scope:** analysis only — no ZedSuite code was changed. Based on 21 real WinOLS
`.ols` projects (Bosch EDC17 ×11, Siemens EMS S8 ×3, Delphi CRD3 ×2, Bosch MD1
×1, TRW EMS ×1, plus a few unlabeled), from which byte-exact map addresses,
dimensions and types were reverse-engineered as ground truth.

## TL;DR

The generic scanner (`src-tauri/src/detector/generic/mod.rs`) already uses the
right structural signature, but it is hard-wired to ZedSuite's supported ECUs
(EDC15/16) and therefore reads **16-bit big-endian**. Every ECU in this corpus
is **little-endian**, so the scanner detects almost none of their real maps.
**Switching to little-endian alone raises recall from ~3 % to ~80–90 % on the
Bosch EDC17/MD1 families.**

The WinOLS *map identifiers* (`Bosch II 8`, `Statistical 16`, `Bosch Float`, …)
cannot be fed into the scanner at runtime — they live only in the `.ols`, not in
the raw `.bin` being scanned. Their value is as a **ground-truth corpus** to fix
and tune the scanner, and as the signal for **which data widths to search**.

## How the scanner works today

Walks the binary word-by-word looking for:

```
[ X axis : cols strictly-increasing 16-bit BE words ]
[ Y axis : rows strictly-increasing 16-bit BE words ]
[ data   : rows*cols 16-bit BE words                ]
```

Constraints: 16-bit **big-endian**; axes **strictly increasing**; `cols` 4–32,
`rows` 2–32; 16-bit data only. This matches the layout the `.ols` files confirm
is real — the foundation is correct.

## Key finding: endianness

The `.ols` corpus is 100 % little-endian ECUs. Real axes read as clean monotonic
breakpoints in LE and as noise in BE. Detectability of *real* maps (ground truth)
under each relaxation:

| File | Current (BE, strict, ≤32) | + little-endian | + non-decreasing axes | + no dim cap |
|------|---------------------------|-----------------|-----------------------|--------------|
| BMW EDC17C50   | **21 / 794 (3 %)**  | 627 (79 %) | 650 | 653 (82 %) |
| Audi EDC17CP44 | **33 / 1109 (3 %)** | 949 (86 %) | 986 | 989 (89 %) |
| Peugeot MD1    | **105 / 808 (13 %)**| 369 (46 %) | 433 | 444 (55 %) |
| Scania EMS S8  | 0 / 32              | 0          | 3   | 3 (9 %)    |

Endianness is by far the dominant lever.

## The map identifier — what it can and can't do

Full identifier vocabulary across the corpus (count → data width):

| identifier | count | width |
|---|---|---|
| Bosch II 16 | 9000 | 16-bit |
| Statistical 16 | 2197 | 16-bit |
| BoschTRW 16 | 546 | 16-bit |
| Bosch III 16/8 | 487 | 16-bit |
| Bosch II 8 | 314 | 8-bit |
| Statistical 8 | 293 | 8-bit |
| Statistical 32 | 86 | 32-bit |
| Bosch III 8 | 77 | 8-bit |
| Bosch III 16 | 66 | 16-bit |
| Bosch Float | 35 | 32-bit float |
| Bosch 16 / IV 16 / Denso Vertical 16 / Delphi 16 | ~100 | 16-bit |
| Bosch3d 8 / Denso Vertical 8 / Bosch 8 (alt) | ~20 | 8-bit |

- **Not usable at runtime:** these names exist only inside the `.ols` container.
  A raw dump carries no such labels, so the scanner cannot read an identifier off
  the file it scans.
- **Usable as design input:** the vocabulary shows the scanner should search
  **8-bit and 32-bit/float** tables too — the corpus has ~700+ real **8-bit**
  maps the current 16-bit-only scanner can never find.
- **Usable as a test corpus:** the reverse-engineered decoder yields byte-exact
  address/dims/type for ~10 000 real maps across these ECUs — a ready-made
  labeled set for measuring scanner precision/recall.

## Recommendations (prioritized)

1. **Auto-detect endianness** (biggest win, lowest risk). Try BE and LE, keep
   whichever yields more valid monotonic-axis tables — or expose it as a scan
   option. Recovers ~80–90 % on EDC17.
2. **Add 8-bit (and float) table search**, guided by the width vocabulary above.
3. **Relax axis test** from strictly-increasing to non-decreasing (real axes can
   repeat endpoints) and **raise the 32×32 dim cap** (e.g. BMW has 40-wide maps).
4. **Note axis order:** the real Bosch layout is `[Y-axis][X-axis][data]`; the
   scanner labels them `[X][Y]`, so detected X/Y come out swapped (cosmetic for
   "potential maps", but worth fixing when labels matter).
5. **Adopt the `.ols` corpus as a regression test** for the scanner.

## Caveats

- **Siemens EMS S8** and **TRW EMS** store axes differently (not a simple
  contiguous increasing block); even a fixed scanner finds few of those.
- For files imported through an `.ols` import path, scanner quality is moot — the
  real maps are already imported. Scanner improvements matter for dumps where no
  `.ols` exists.

---
*Generated from analysis of a local set of WinOLS `.ols` projects.*
