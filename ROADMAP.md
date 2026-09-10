# ZedSuite roadmap

This page lists what is planned, what users asked for and what is not planned.

To ask for a feature or report a bug: open an issue on [GitHub](https://github.com/LeZed97/ZedSuite/issues), post in the [ecuconnections thread](https://www.ecuconnections.com/forum/viewtopic.php?p=393279#p393279), or reach me on my social networks: [linktr.ee/zedperf](https://linktr.ee/zedperf). Every report is read.

## General File Editor — community fork (ongoing beta)

> **This is an ongoing beta.** It works and is usable day to day, but expect a
> few small bugs while it matures. The goal is to grow this into a full-featured
> **file editor** — many more features are planned and being added over time.
> Feedback and bug reports are very welcome.

The features below were built on top of this codebase in a community fork and are offered back as contributions. They are all local-only and keep the project's core rule intact: heuristic or user-created data is stored **separately** from the trusted per-family detection (`potential_maps`, `my_maps`), so nothing can pass as a verified map. Several of them cover items listed under *Planned* and *Asked by users* below.

**Unrecognized files**
- A generic, family-agnostic *potential maps* scanner (Rust) runs on files the strict identifier rejects: it finds candidate 2D tables and 1D curves by their structure (two monotonic axes + data), names them `Potential map @0x…`, and stores them in a separate `potential_maps` field at low confidence. Byte order is **auto-detected** (it scans big- and little-endian and keeps whichever finds more, so it works on the little-endian families — EDC17, MD1 — the app has no detector for), and it searches both **16-bit and 8-bit** tables. Validated against a corpus of ~10 000 real maps reverse-engineered from WinOLS `.ols` projects.
- An **Import anyway & scan for potential maps** button on the "ECU not detected" panel creates a project (type `unknown`) from an unrecognized file, with the candidates listed in a **Potential maps** sidebar folder and highlighted in the hexdump.

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

## Planned

- Comparing the maps of two versions of a project in the Compare window, which does the binary comparison today: the same map of both versions side by side, differences highlighted.
- WinOLS-style 2D view for full matrices: one curve per row, selected row highlighted.
- An N75 inversion switch on EDC15VM, for cars converted from a wastegate turbo to a VNT or the reverse: the block that controls it is located on most files of the bench, the switch itself is not built yet.
- EDC15P early PD software (1999-2002, 038906019A / 019AJ): map detection is done and the DTC table is read on the 019AJ; the checksum is not supported yet, the DTC table of the 019A uses yet another layout, and the MAP linearisation map is not found on the 019A.
- Better EDC15VM detection: a few files are still not fully covered, the 2.5 V6 in particular, and the N146 and N75 maps of the 012K / 012AP generation. Fixes are in for the software numbers users sent (012M single SOI and MAP/MAF switch in 1.1.7).
- EDC15VM: check on the car that the SVRL maps are really active when the detector finds them.
- EDC16U31: better detection, a few EDC16U31 files are still missing from the test bench to finish it properly (the 12x12 family at 0x1D7xxx is still unnamed).
- EDC16U1: identification of the Touareg V10 files, where only one of the two ECU numbers is found today (six files on the bench).
- Detection of the turbo boost control PID maps, on EDC15P first.

## Asked by users, under review

- Undo with Ctrl+Z in the editor.
- CSV import and export (the JSON mappack for WinOLS is already there), and DAMOS import.
- Favourite maps, for quick access to the ones you edit most.
- A reference version other than Ori for "original value" and the comparison.
- Inverse driver wish and MAF linearisation in the map list.
- Editing maps directly in the 3D view.
- Tuning the power estimate for nozzles other than Firad, such as Recambo or DSSR.
- Editing two versions of the same project side by side.
- More functions in the map Properties window.
- Highlighting every value that differs from stock in the map windows.
- Remembering the map orientation (axis mirror): today the display transposition is set map by map, in one project only. The plan is to apply the choice to the whole map family at once and to save it as a global setting, so every project opens the maps the same way.
- A Linux version. The interface is the same code as on Windows and macOS, only the shell side would need doing; it depends on how many people ask for it.

## Not planned for now

- Adding new ECUs (BMW and PSA EDC15/EDC16, etc.).
- A map switching routine (multimap) patched into the ECU: do it in WinOLS with the routines that circulate for EDC15, then import the file as a version, the added codeblock and its maps are shown since 1.1.6.
- More ECU reference data (brands, engines) for the import screen.
- Windows 7 compatibility.
