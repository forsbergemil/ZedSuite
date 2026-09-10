# ZedSuite — General File Editor fork · roadmap

This is the roadmap for the **General File Editor** fork of ZedSuite — the community branch that grows ZedSuite from a VAG EDC15/EDC16 map editor into a general ECU **file editor**. It lists what the fork already ships and what is planned next, in order.

To report a bug or ask for a feature on this fork, open an issue on [the fork's GitHub](https://github.com/forsbergemil/ZedSuite/issues). For the base ZedSuite (VAG EDC15/EDC16) roadmap, see the [upstream project](https://github.com/LeZed97/ZedSuite).

## Shipped so far (ongoing beta)

> **This is an ongoing beta.** It works and is usable day to day, but expect a
> few small bugs while it matures. The goal is to grow this into a full-featured
> **file editor** — many more features are planned and being added over time.
> Feedback and bug reports are very welcome.

Everything below is already in the branch. It is all local-only and keeps the project's core rule intact: heuristic or user-created data is stored **separately** from the trusted per-family detection (`potential_maps`, `my_maps`), so nothing can pass as a verified map.

**Unrecognized files**
- A generic, family-agnostic *potential maps* scanner (Rust) runs on files the strict identifier rejects: it finds candidate 2D tables and 1D curves by their structure (two monotonic axes + data), names them `Potential map @0x…`, and stores them in a separate `potential_maps` field at low confidence. Byte order is **auto-detected** (it scans big- and little-endian and keeps whichever finds more, so it works on the little-endian families — EDC17, MD1 — the app has no detector for), and it searches both **16-bit and 8-bit** tables. Validated against a corpus of ~10 000 real maps reverse-engineered from WinOLS `.ols` projects.
- An **Import anyway & scan for potential maps** button on the "ECU not detected" panel creates a project (type `unknown`) from an unrecognized file, with the candidates listed in a **Potential maps** sidebar folder and highlighted in the hexdump.
- A **Re-scan map area** button (↻) on the Potential maps folder re-runs the scanner over just the ECU's calibration/MAP region instead of the whole file — it skips the leading program/code region and the trailing flash-fill (the "skip code, scan the rest" heuristic). **EDC17 first**: its OS/code occupies the low half of the flash, so the low half is skipped and only the upper data region is scanned; other families scan from the start with the trailing fill trimmed. The folder is also available (with a hint to press ↻) on beta/unknown files that have no candidates yet.
- **Imported versions of beta/unknown files now diff the whole file.** Selecting a version created by importing a tuned file compares **every byte** against the original — not only the bytes inside a detected map — so on families with no trusted map list (EDC17) the changes are shown in the hexdump, counted, saved as a new version and exported faithfully. Previously the imported delta was dropped on these files and a new version saved from it came out empty.

**My Maps — user-created maps**
- A **Create map** modal (on every project) to define a map by hand: name, start address, 2D/1D/single shape, rows × cols, 8/16-bit, sign, byte order, and optional factor/offset/unit/axis addresses, with live validation. Created maps open in the normal table/2D/3D editor and are stored separately in `my_maps`.
- **Create map from a hexdump selection**: drag-select a byte range and the create modal opens pre-seeded from it.
- **Editable map Properties for user maps** — Word size, Data org, Sign, Format, Start address and Width × Height become editable (read-only for detected maps), and the window re-decodes on save. Switching 16b↔8b keeps the same byte region so no data is lost. *(Covers "More functions in the map Properties window".)*

**Custom Solutions**
- Turn a file **version** into a reusable one-click **solution** (saved in app data, reusable across projects). Applying to a different-sized file **searches the target for the stored signature** and verifies the original bytes before writing, so a solution made from a partial dump applies to a full dump of the same calibration.

**Compare window**
- Compare **two versions from different projects**, not just within one project (external versions are reconstructed from base + edits). *(Relates to "Editing two versions of the same project side by side".)*
- **Per-side comparison reference**: each side chooses what it displays and what it is compared to (the other panel, or any specific file such as its own Ori), each panel colored against its own reference, with **two independent difference counters**. *(Covers "A reference version other than Ori for the comparison".)*
- **Offset-aware diffs**: the highlighting and counts recompute across the current alignment offset as you change it, so you can see when two files line up.
- **Sync-scroll lock/unlock at an offset**, and **Find selected area in the other file** (search the other side for a dragged selection, align and lock on the match).

**Hexdump — now editable**
- **Double-click a cell to edit a byte** in the current Hex/Dec format and word size/byte order; edits flow through the same save path as solutions.
- **Mod / Ori / %** view modes and **◀ n/N ▶ changed-byte navigation** in the top toolbar. *(The % view relates to "Highlighting every value that differs from stock in the map windows".)*

**Map viewer view modes**
- **ASCII** (read a 1D/text map as characters), **Ori** (original vs modified) and **%** (percent change vs original) toggles in the Text view.

**Other**
- The project brand dropdown lists the full range of car brands instead of four.
- Bug fixes: per-file write serialization in the store (fixed map Properties reverting on reopen), a setState-during-render fix in hexdump editing, and a double-submit guard on "Import anyway".

## The road ahead (planned, in order)

The fork is being built out roughly in the order below. Each step builds on the
one before it: the end goal is real, per-family map detection and checksums for
ECUs the base app does not cover, reached by growing the generic tooling into
family-aware detection rather than hand-writing every detector from scratch.

1. **Finish and harden import / export in the hexdump.** Make every path in and
   out of the hexdump reliable: import a file or a tuned version, edit bytes,
   save it as a new version and export the binary — with the full
   original-vs-file delta preserved on *every* family, including the beta/unknown
   ones that have no trusted map list. *(The imported-version whole-file diff in
   "Shipped so far" is the first piece of this.)*

2. **`CTRL+O` to toggle Ori ⇄ Mod in the hexdump.** A keyboard shortcut that
   flips the hexdump between the original (stock) values and the modified values,
   so a change can be checked against stock without leaving the keyboard.
   Complements the existing Mod / Ori / % view buttons and the ◀ n/N ▶
   changed-byte navigation.

3. **Broaden the ECU identifier.** Review and extend positive identification
   across more families and brands so their files are recognized (at least as a
   named beta family) instead of rejected or left as `unknown`:
   - VAG
   - Volvo
   - BMW **EDC17**
   - Bosch **MD1**
   - Delphi **CRD3**
   - TRW **EMS2.3** and **EMS2.4**
   - **SID310**

4. **Search for software / part numbers inside the file.** Extract the ECU and
   software-version strings directly from the binary (ASCII and encoded, Bosch /
   VAG / brand formats) to label the project, refine identification, and drive
   the map-area and checksum logic per calibration.

5. **Identify the map area of a file.** Generalize the EDC17 "map area" work into
   a family-aware resolver that locates the calibration/data region — skipping
   code, headers and flash-fill — for each ECU layout, so scanning and detection
   run only where maps actually live.

6. **Identify the maps inside that area.** Move from generic "potential maps"
   candidates toward real map detection within the resolved area: structural
   signatures, axis/data typing and naming per family, promoting confident finds
   out of `potential_maps`.

7. **A checksum module for each ECU.** A checksum implementation per family so an
   edited file can be corrected and exported ready to flash — the same native,
   byte-validated approach the base app uses for EDC15/EDC16, extended to the new
   families (EDC17, MD1, CRD3, EMS2.x, SID310, …).

Feedback and bug reports on any of this are very welcome — it is an ongoing beta.
