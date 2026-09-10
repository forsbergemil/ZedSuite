# ZedSuite — General File Editor fork · roadmap

This is the roadmap for the **General File Editor** fork of ZedSuite — the community branch that grows ZedSuite from a VAG EDC15/EDC16 map editor into a general ECU **file editor**. It lists what the fork already ships and what is planned next, in priority order.

To report a bug or ask for a feature on this fork, open an issue on [the fork's GitHub](https://github.com/forsbergemil/ZedSuite/issues). For the base ZedSuite (VAG EDC15/EDC16) roadmap, see the [upstream project](https://github.com/LeZed97/ZedSuite).

> **This is an ongoing beta.** It works and is usable day to day, but expect a few small bugs while it matures. The goal is to grow this into a full-featured **file editor** — many more features are planned and being added over time. Feedback and bug reports are very welcome.
>
> Everything below keeps the project's core rule intact: heuristic or user-created data is stored **separately** from the trusted per-family detection (`potential_maps`, `my_maps`), so nothing can pass as a verified map. All local-only.

## Planned (prioritized)

Priority key: **P0** must ship · **P1** should ship · **P2** nice to have. Ordered most-to-least important; each step builds toward real, per-family map detection and checksums for ECUs the base app does not cover.

- [ ] **P0 — Finish and harden import / export in the hexdump.** Make every path in and out of the hexdump reliable: import a file or tuned version, edit bytes, save as a new version, export the binary — with the full original-vs-file delta preserved on *every* family, including beta/unknown ones with no trusted map list. *(The imported-version whole-file diff below is the first piece.)*
- [ ] **P0 — Broaden the ECU identifier.** Extend positive identification across more families/brands so files are recognized (at least as a named beta family) instead of rejected or left `unknown`: VAG · Volvo · BMW **EDC17** · Bosch **MD1** · Delphi **CRD3** · TRW **EMS2.3**/**EMS2.4** · **SID310**.
- [ ] **P0 — Search for software / part numbers inside the file.** Extract ECU and software-version strings from the binary (ASCII and encoded; Bosch / VAG / brand formats) to label the project, refine identification, and drive map-area and checksum logic per calibration.
- [ ] **P1 — Identify the map area of a file.** Generalize the EDC17 "map area" work into a family-aware resolver that locates the calibration/data region — skipping code, headers and flash-fill — for each ECU layout, so scanning runs only where maps live.
- [ ] **P1 — Identify the maps inside that area.** Move from generic "potential maps" candidates toward real map detection within the resolved area: structural signatures, axis/data typing and naming per family, promoting confident finds out of `potential_maps`.
- [ ] **P1 — A checksum module for each ECU.** A per-family checksum implementation so an edited file can be corrected and exported ready to flash — the same native, byte-validated approach the base app uses for EDC15/EDC16, extended to the new families (EDC17, MD1, CRD3, EMS2.x, SID310, …).
- [ ] **P2 — `CTRL+O` to toggle Ori ⇄ Mod in the hexdump.** Keyboard shortcut to flip the hexdump between stock and modified values without leaving the keyboard. Complements the existing Mod / Ori / % view buttons and ◀ n/N ▶ changed-byte navigation.

## Shipped so far (ongoing beta)

### Unrecognized files
- [x] Generic, family-agnostic *potential maps* scanner (Rust) on files the strict identifier rejects — finds candidate 2D tables and 1D curves by structure, names them `Potential map @0x…`, stores them in `potential_maps` at low confidence. Byte order **auto-detected** (big/little-endian, so it works on EDC17/MD1 with no detector), searches both **16-bit and 8-bit** tables. Validated against ~10,000 real maps from WinOLS `.ols` projects.
- [x] **Import anyway & scan for potential maps** button on the "ECU not detected" panel — creates a project (type `unknown`) from an unrecognized file, with candidates in a **Potential maps** sidebar folder, highlighted in the hexdump.
- [x] **Re-scan map area** (↻) button — re-runs the scanner over just the ECU's calibration/MAP region, skipping the leading code region and trailing flash-fill. **EDC17 first** (skips low-half OS/code, scans upper data region); other families scan from the start with trailing fill trimmed. Folder also shown (with ↻ hint) on beta/unknown files with no candidates yet.
- [x] **Imported versions of beta/unknown files diff the whole file** — selecting a version created by importing a tuned file compares every byte against the original, so on families with no trusted map list (EDC17) changes are shown, counted, saved and exported faithfully. Previously the imported delta was dropped and came out empty.

### My Maps — user-created maps
- [x] **Create map** modal (every project) — define a map by hand: name, start address, 2D/1D/single shape, rows × cols, 8/16-bit, sign, byte order, optional factor/offset/unit/axis addresses, with live validation. Opens in the normal table/2D/3D editor, stored in `my_maps`.
- [x] **Create map from a hexdump selection** — drag-select a byte range; the create modal opens pre-seeded from it.
- [x] **Editable map Properties for user maps** — Word size, Data org, Sign, Format, Start address and Width × Height become editable (read-only for detected maps); re-decodes on save. Switching 16b↔8b keeps the byte region so no data is lost.

### Custom Solutions
- [x] Turn a file **version** into a reusable one-click **solution** (saved in app data, reusable across projects). Applying to a different-sized file searches the target for the stored signature and verifies original bytes before writing, so a solution from a partial dump applies to a full dump of the same calibration.

### Compare window
- [x] Compare **two versions from different projects**, not just within one (external versions reconstructed from base + edits).
- [x] **Per-side comparison reference** — each side chooses what it displays and what it's compared to (the other panel, or any specific file such as its own Ori), colored against its own reference, with two independent difference counters.
- [x] **Offset-aware diffs** — highlighting and counts recompute across the current alignment offset as you change it.
- [x] **Sync-scroll lock/unlock at an offset**, and **Find selected area in the other file** (search the other side for a dragged selection, align and lock on the match).

### Hexdump — now editable
- [x] **Double-click a cell to edit a byte** in the current Hex/Dec format and word size/byte order; edits flow through the same save path as solutions.
- [x] **Mod / Ori / %** view modes and **◀ n/N ▶** changed-byte navigation in the top toolbar.

### Map viewer view modes
- [x] **ASCII** (read a 1D/text map as characters), **Ori** (original vs modified) and **%** (percent change vs original) toggles in the Text view.

### Other
- [x] Project brand dropdown lists the full range of car brands instead of four.
- [x] Bug fixes: per-file write serialization in the store (map Properties reverting on reopen), a setState-during-render fix in hexdump editing, a double-submit guard on "Import anyway".

---

Feedback and bug reports on any of this are very welcome — it is an ongoing beta.
