"use client";

import { useEffect, useState, useRef, useMemo, useCallback, memo } from "react";

// Map region interface for highlighting
export interface MapRegion {
  name: string;
  address: number;
  size: number;
  codeblock_id?: number | null;
  dimensions?: {
    TwoDimensional?: {
      rows: number;
      cols: number;
    };
  };
}

interface HexdumpViewerProps {
  fileData: number[];
  // Données du fichier ORIGINAL (jamais modifié) : sert à colorer les valeurs
  // modifiées (rouge = au-dessus de l'origine, bleu = en dessous, comme
  // WinOLS 5) et à marquer les modifications dans la minimap.
  originalFileData?: number[];
  fileName: string;
  size?: "8b" | "16b";
  // Ordre des octets en 16 bits : "hilo" = octet fort d'abord (big-endian,
  // EDC16/MJD), "lohi" = octet faible d'abord (little-endian, EDC15).
  byteOrder?: "hilo" | "lohi";
  format?: "hex" | "dec";
  containerWidth?: string;
  minWidthOverride?: string;
  theme?: "default" | "light" | "oled";
  mapRegions?: MapRegion[]; // List of maps to highlight
  selectedMapAddress?: number | null; // Currently selected map address (for scrolling to it)
  onMapClick?: (mapRegion: MapRegion) => void; // Callback when a map region is clicked
  onScrollComplete?: () => void; // Callback when scroll to selected map is complete
  // Search results highlighting
  searchResults?: number[]; // Array of addresses where search matches were found
  currentSearchIndex?: number; // Index of the currently focused search result
  searchDataSize?: '8b' | '16b'; // Size of the searched data (to highlight correct bytes)
  scrollKey?: number; // Key to force scroll even when address is the same
  // Search button
  onSearchClick?: () => void; // Callback when search button is clicked
  searchButtonLabel?: string; // Label for the search button (i18n)
  // "Create map from selection": when provided, a toggle appears that lets the
  // user drag-select a byte range and turn it into a map. The callback gets the
  // selection's start byte and its length in bytes.
  onCreateMapFromSelection?: (startByte: number, byteCount: number) => void;
  createMapLabel?: string;
  // Reports the start byte of the current cell selection (drag-select works in
  // the hexdump at all times, not only in create-map mode) so the toolbar's
  // change navigator can start counting differences from the selected byte.
  // null when the selection is cleared.
  onSelectionStartChange?: (startByte: number | null) => void;
  // The difference the toolbar's ◀/▶ navigator last jumped to: outlined in
  // yellow so the current change stands out. null = none.
  currentChangeAddress?: number | null;
  // Per-cell display (controlled from the editor toolbar): current bytes,
  // original bytes, or % change vs original.
  displayMode?: "modified" | "original" | "percent";
  // Reports the sorted list of changed byte addresses (current vs original) so
  // the toolbar's change navigator can jump between them.
  onDiffAddressesChange?: (addrs: number[]) => void;
  // Inline byte editing: double-click a value cell, type a new value (in the
  // current hex/dec format), Enter to commit. Gives the value's byte offset and
  // the new value (8- or 16-bit per the current word size).
  onValueEdit?: (byteOffset: number, newValue: number) => void;
  // Bulk edit: with values selected, ENTER types one value applied to EVERY
  // selected value. Gets the list of selected value-start byte offsets.
  onValuesFill?: (addrs: number[], newValue: number) => void;
  // Restore selection to stock (F11): sets every selected value back to the
  // original file's bytes. Gets the selected value-start byte offsets.
  onValuesRestore?: (addrs: number[]) => void;
  // Paste (Ctrl+V): write consecutive values starting at startByte.
  onValuesPaste?: (startByte: number, values: number[]) => void;
  // + / - : adjust every selected value by (sign × toolbar step). sign is +1/-1.
  onValuesAdjust?: (addrs: number[], sign: 1 | -1) => void;
  // Reports the pixel width the value grid needs (grows with the columns count)
  // so the host window can expand to fit it.
  onContentWidthChange?: (px: number) => void;
  // Persisted "values per row": `columns` seeds/updates it from saved project
  // settings; `onColumnsChange` reports the current value back for saving.
  columns?: number;
  onColumnsChange?: (columns: number) => void;
}

// Single color for all maps - solid gray with border
const MAP_COLOR = {
  bg: '#3a3a3a',
  border: '#6a6a6a',
  text: '#ffffff',
  labelBg: '#4a4a4a',
};

// Search result highlight colors
const SEARCH_COLOR = {
  bg: '#b8860b', // Dark goldenrod for all results
  currentBg: '#ffd700', // Bright gold for current result
  text: '#000000',
};

// Couleurs des valeurs modifiées vs fichier d'origine (convention WinOLS 5) :
// au-dessus de l'origine = rouge, en dessous = bleu.
const DIFF_COLORS = {
  dark: { above: '#ff5252', below: '#4da3ff' },
  light: { above: '#c62828', below: '#1565c0' },
};

// Largeur de la colonne minimap (px) — réduite de 25 % (32 → 24)
const MINIMAP_WIDTH = 24;

const ROW_HEIGHT = 18;
// Rows rendered above/below the viewport. The visible range is quantized to
// CHUNK-row steps so scrolling only triggers a re-render every CHUNK rows
// instead of on every scroll event.
const OVERSCAN = 30;
const RANGE_CHUNK = 25;

type ByteMapInfo = { mapRegion: MapRegion; isStart: boolean; isEnd: boolean };
type ByteSearchInfo = { isCurrent: boolean; isStart: boolean };

interface HexRowProps {
  rowIndex: number;
  fileData: number[];
  // Fichier original (identité stable) pour la coloration des modifications
  originalFileData: number[] | null;
  fileDataLength: number;
  size: "8b" | "16b";
  byteOrder: "hilo" | "lohi";
  format: "hex" | "dec";
  theme: "default" | "light" | "oled";
  bytesPerValue: number;
  valuesPerRow: number;
  bytesPerRow: number;
  // Which data to show per cell: current ("modified"), the original bytes, or
  // the % change vs original. Diff colouring stays consistent across modes.
  displayMode: "modified" | "original" | "percent";
  byteToMapInfo: Map<number, ByteMapInfo>;
  byteToSearchInfo: Map<number, ByteSearchInfo>;
  // The hovered map ONLY when it intersects this row, null otherwise —
  // keeps the memo effective for every other row.
  hoveredMap: MapRegion | null;
  // Byte-selection (Create map from selection). selStartVal/selEndVal are the
  // min/max value-start byte offsets of the current selection (null = none).
  selectMode: boolean;
  selStartVal: number | null;
  selEndVal: number | null;
  // Discontiguous selection (Shift+Alt+D); when non-null it supersedes the range.
  selectedSet: Set<number> | null;
  // Grid alignment shift in bytes (Ctrl+←/→). The row's first column maps to
  // file byte `rowIndex*bytesPerRow - alignOffset`; negative offsets render blank
  // so a map's values can be lined up to a column boundary.
  alignOffset: number;
  // Byte address of the difference the change-navigator is currently on.
  currentChangeAddress: number | null;
  onByteClick: (byteAddress: number) => void;
  onByteHover: (byteAddress: number | null) => void;
  onLabelClick: (mapRegion: MapRegion) => void;
  onLabelHover: (mapRegion: MapRegion | null) => void;
  onCellSelectDown: (byteAddress: number) => void;
  onCellSelectEnter: (byteAddress: number) => void;
  // Inline editing: -1 when no cell in this row is being edited.
  editable: boolean;
  editingByteOffset: number;
  editDraft: string;
  onEditStart: (byteAddress: number) => void;
  onEditChange: (value: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
}

// Selection highlight (Create map from selection) — a calm blue, distinct
// from the map gray and the search gold.
const SELECT_COLOR = { bg: '#2f5fb0', text: '#ffffff' };

// One hexdump row. Memoized: during scrolling the already-mounted rows keep
// strictly identical props (stable maps/handlers from the parent), so React
// skips them entirely and only mounts the rows entering the window. Without
// this, dragging the scrollbar re-rendered every visible row on every scroll
// event and the table went blank until mouse release.
/** Lecture d'une valeur 16 bits selon l'ordre des octets choisi. */
const read16 = (arr: number[], off: number, order: "hilo" | "lohi"): number =>
  order === "hilo" ? ((arr[off] << 8) | arr[off + 1]) : (arr[off] | (arr[off + 1] << 8));

const HexRow = memo(function HexRow({
  rowIndex,
  fileData,
  originalFileData,
  fileDataLength,
  size,
  byteOrder,
  format,
  theme,
  bytesPerValue,
  valuesPerRow,
  bytesPerRow,
  displayMode,
  byteToMapInfo,
  byteToSearchInfo,
  hoveredMap,
  selectMode,
  selStartVal,
  selEndVal,
  selectedSet,
  alignOffset,
  currentChangeAddress,
  onByteClick,
  onByteHover,
  onLabelClick,
  onLabelHover,
  onCellSelectDown,
  onCellSelectEnter,
  editable,
  editingByteOffset,
  editDraft,
  onEditStart,
  onEditChange,
  onEditCommit,
  onEditCancel,
}: HexRowProps) {
  const textColor = theme === 'light' ? '#000000' : '#ffffff';
  const addressColor = theme === 'light' ? '#000000' : '#e1e1e1';
  const asciiColor = theme === 'light' ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.7)';
  const emptyColor = theme === 'light' ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.2)';
  const hoverBg = theme === 'light' ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';

  const startByte = rowIndex * bytesPerRow - alignOffset;
  const address = Math.max(0, startByte).toString(16).toUpperCase().padStart(5, '0');

  const values: JSX.Element[] = [];
  const asciiValues: JSX.Element[] = [];

  // Check if this row contains any map starts (for label display)
  const mapStartsInRow: { mapRegion: MapRegion; byteOffset: number }[] = [];
  for (let j = 0; j < bytesPerRow; j++) {
    const byteOffset = startByte + j;
    if (byteOffset < 0) continue;
    const mapInfo = byteToMapInfo.get(byteOffset);
    if (mapInfo?.isStart) {
      mapStartsInRow.push({ mapRegion: mapInfo.mapRegion, byteOffset });
    }
  }

  // ASCII representation
  for (let j = 0; j < bytesPerRow; j++) {
    const byteOffset = startByte + j;
    const mapInfo = byteOffset >= 0 ? byteToMapInfo.get(byteOffset) : undefined;

    let char = ' ';
    if (byteOffset >= 0 && byteOffset < fileDataLength) {
      const byte = fileData[byteOffset];
      char = (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '.';
    }

    asciiValues.push(
      <span
        key={`ascii-${j}`}
        className={`${mapInfo ? 'cursor-pointer' : ''}`}
        onClick={() => mapInfo && onByteClick(byteOffset)}
      >
        {char}
      </span>
    );
  }

  // Values display
  for (let j = 0; j < valuesPerRow; j++) {
    const byteOffset = startByte + (j * bytesPerValue);
    const mapInfo = byteToMapInfo.get(byteOffset);
    const searchInfo = byteToSearchInfo.get(byteOffset);

    let displayValue = '';
    // -1 = valeur sous l'origine (bleu), +1 = au-dessus (rouge), 0 = intacte
    let diffSign = 0;
    if (byteOffset >= 0 && byteOffset + bytesPerValue <= fileDataLength) {
      const cur = size === "8b" ? fileData[byteOffset] : read16(fileData, byteOffset, byteOrder);
      const hasOrig = !!originalFileData && byteOffset + bytesPerValue <= originalFileData.length;
      const orig = hasOrig
        ? (size === "8b" ? originalFileData![byteOffset] : read16(originalFileData!, byteOffset, byteOrder))
        : cur;
      // Diff sign (colouring) always reflects current vs original.
      if (cur > orig) diffSign = 1;
      else if (cur < orig) diffSign = -1;

      const fmt = (v: number) => size === "8b"
        ? (format === "hex" ? v.toString(16).toUpperCase().padStart(2, '0') : v.toString(10).padStart(3, '0'))
        : (format === "hex" ? v.toString(16).toUpperCase().padStart(4, '0') : v.toString(10).padStart(5, '0'));

      if (displayMode === "original") {
        displayValue = fmt(orig);
      } else if (displayMode === "percent") {
        if (orig === 0) {
          displayValue = cur === 0 ? '0' : '±';
        } else {
          const pct = Math.round(((cur - orig) / orig) * 100);
          displayValue = (pct > 0 ? '+' : '') + pct;
        }
      } else {
        displayValue = fmt(cur);
      }
    } else {
      displayValue = size === "8b" ? (format === "hex" ? '  ' : '   ') : (format === "hex" ? '    ' : '     ');
    }

    // Phantom cell: shifted off the front of the file by the alignment offset.
    // Blank and non-interactive.
    const isPhantom = byteOffset < 0;
    const isInMap = !isPhantom && !!mapInfo;
    const isHovered = hoveredMap !== null && mapInfo?.mapRegion === hoveredMap;
    const isSearchResult = !isPhantom && !!searchInfo;
    const isCurrentSearchResult = searchInfo?.isCurrent ?? false;
    const isSelected = isPhantom ? false : (selectedSet
      ? selectedSet.has(byteOffset)
      : (selStartVal !== null && selEndVal !== null &&
         byteOffset >= selStartVal && byteOffset <= selEndVal));
    const isCurrentChange = currentChangeAddress !== null && byteOffset === currentChangeAddress;

    // Determine background color: an active byte selection wins, then search
    // results, then map highlighting.
    let bgColor: string | undefined;
    if (isSelected) {
      bgColor = SELECT_COLOR.bg;
    } else if (isSearchResult) {
      bgColor = isCurrentSearchResult ? SEARCH_COLOR.currentBg : SEARCH_COLOR.bg;
    } else if (isInMap) {
      bgColor = isHovered ? MAP_COLOR.border : MAP_COLOR.bg;
    }

    // Determine text color. Priorité : sélection > recherche (fond doré, texte
    // noir) > modification vs origine (rouge/bleu WinOLS) > map > normal.
    const diffColors = theme === 'light' ? DIFF_COLORS.light : DIFF_COLORS.dark;
    let cellTextColor: string;
    if (isSelected) {
      cellTextColor = SELECT_COLOR.text;
    } else if (isSearchResult) {
      cellTextColor = SEARCH_COLOR.text;
    } else if (diffSign !== 0) {
      cellTextColor = diffSign > 0 ? diffColors.above : diffColors.below;
    } else if (isInMap) {
      cellTextColor = MAP_COLOR.text;
    } else {
      cellTextColor = displayValue.trim() === '' ? emptyColor : textColor;
    }

    const isEditingCell = editingByteOffset === byteOffset;
    const cellWidth = size === "16b" ? '2.4rem' : '1.85rem';
    values.push(
      isEditingCell ? (
        <input
          key={`val-${j}`}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          value={editDraft}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onEditCommit(); }
            else if (e.key === 'Escape') { e.preventDefault(); onEditCancel(); }
            e.stopPropagation();
          }}
          onBlur={onEditCommit}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="text-center font-mono outline-none"
          style={{
            width: cellWidth,
            marginRight: '2px',
            background: theme === 'light' ? '#fff' : '#000',
            color: theme === 'light' ? '#000' : '#fff',
            border: '1px solid #f59e0b',
            borderRadius: '2px',
            fontSize: '11px',
            padding: 0,
          }}
        />
      ) : (
      <div
        key={`val-${j}`}
        className={`text-center ${selectMode ? 'cursor-crosshair' : (editable ? 'cursor-text' : (isInMap ? 'cursor-pointer' : 'hover:bg-primary/20'))}`}
        style={{
          width: cellWidth,
          backgroundColor: bgColor,
          color: cellTextColor,
          marginRight: '2px',
          borderTop: isInMap ? `1px solid ${MAP_COLOR.border}` : undefined,
          borderBottom: isInMap ? `1px solid ${MAP_COLOR.border}` : undefined,
          borderLeft: mapInfo?.isStart ? `1px solid ${MAP_COLOR.border}` : undefined,
          borderRight: mapInfo?.isEnd ? `1px solid ${MAP_COLOR.border}` : undefined,
          fontWeight: isCurrentSearchResult || diffSign !== 0 || isCurrentChange ? 'bold' : undefined,
          borderRadius: isSearchResult || isSelected || isCurrentChange ? '2px' : undefined,
          // Current change (◀/▶ navigator): yellow outline, drawn inset so it
          // hugs the cell without shifting layout or being clipped by neighbours.
          outline: isCurrentChange ? '2px solid #facc15' : undefined,
          outlineOffset: isCurrentChange ? '-2px' : undefined,
        }}
        onMouseDown={(e) => {
          // Left-drag selects bytes, both in create-map mode and normally. Skip
          // the cell that is currently being edited (its input handles input) and
          // phantom cells shifted off the front of the file.
          if (e.button !== 0 || isPhantom) return;
          if (editingByteOffset === byteOffset) return;
          e.preventDefault(); // don't start a native text selection while dragging
          onCellSelectDown(byteOffset);
        }}
        onClick={() => {
          if (selectMode || isPhantom) return; // create-map mode / phantom: no navigate
          // handleByteClick opens the map underneath, unless a drag just happened.
          onByteClick(byteOffset);
        }}
        onDoubleClick={() => {
          // Double-click a cell to edit its value in place.
          if (editable && !isPhantom && byteOffset + bytesPerValue <= fileDataLength) onEditStart(byteOffset);
        }}
        onMouseEnter={() => {
          if (isPhantom) return;
          onByteHover(byteOffset);
          onCellSelectEnter(byteOffset);
        }}
        onMouseLeave={() => onByteHover(null)}
      >
        {displayValue}
      </div>
      )
    );
  }

  // Get the first map that starts in this row (for the label)
  const firstMapStart = mapStartsInRow[0];

  return (
    <div>
      {/* Data row */}
      <div
        className="flex gap-3 py-[2px] transition-colors font-mono text-[11px]"
        style={{
          position: 'absolute',
          top: `${rowIndex * ROW_HEIGHT}px`,
          left: 0,
          right: 0,
          height: `${ROW_HEIGHT}px`,
        }}
        onMouseEnter={(e) => {
          if (!hoveredMap) e.currentTarget.style.background = hoverBg;
        }}
        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
      >
        {/* Address */}
        <div className="font-semibold flex-shrink-0" style={{ width: '3rem', color: addressColor }}>
          {address}
        </div>

        {/* Values with label overlay */}
        <div className="flex flex-shrink-0 relative">
          {values}

          {/* Map label overlay - always at start of values */}
          {firstMapStart && (() => {
            const { mapRegion } = firstMapStart;
            // Only show a codeblock badge when the map actually belongs to a
            // codeblock (EDC15P). EDC16 & co have codeblock_id null/undefined
            // — showing "CB null" there was a bug.
            const cbStr = typeof mapRegion.codeblock_id === 'number' ? `CB${mapRegion.codeblock_id}` : '';
            const isLabelHovered = hoveredMap === mapRegion;

            return (
              <div
                className="font-mono text-[9px] px-1 cursor-pointer flex items-center absolute"
                style={{
                  left: '0',
                  top: '0',
                  height: '100%',
                  backgroundColor: isLabelHovered ? MAP_COLOR.border : MAP_COLOR.labelBg,
                  color: MAP_COLOR.text,
                  border: `1px solid ${MAP_COLOR.border}`,
                  borderRadius: '2px',
                  whiteSpace: 'nowrap',
                  zIndex: 10,
                }}
                onClick={() => onLabelClick(mapRegion)}
                onMouseEnter={() => onLabelHover(mapRegion)}
                onMouseLeave={() => onLabelHover(null)}
                title={`${mapRegion.name}${cbStr ? ` [${cbStr}]` : ''}`}
              >
                {mapRegion.name} {cbStr && `[${cbStr}]`}
              </div>
            );
          })()}
        </div>

        {/* ASCII */}
        <div className="tracking-normal flex-shrink-0" style={{ color: asciiColor }}>
          {asciiValues}
        </div>
      </div>
    </div>
  );
});

export function HexdumpViewer({
  fileData,
  originalFileData,
  fileName,
  size = "8b",
  byteOrder = "lohi",
  format = "hex",
  containerWidth = "30%",
  minWidthOverride,
  theme = "default",
  mapRegions = [],
  selectedMapAddress = null,
  onMapClick,
  onScrollComplete,
  searchResults = [],
  currentSearchIndex = -1,
  searchDataSize = '8b',
  scrollKey = 0,
  onSearchClick,
  searchButtonLabel = "Search",
  onCreateMapFromSelection,
  createMapLabel = "Create map",
  onSelectionStartChange,
  currentChangeAddress = null,
  displayMode = "modified",
  onDiffAddressesChange,
  onValueEdit,
  onValuesFill,
  onValuesRestore,
  onValuesPaste,
  onValuesAdjust,
  onContentWidthChange,
  columns,
  onColumnsChange,
}: HexdumpViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const headerColsRef = useRef<HTMLDivElement>(null); // offset header, synced to horizontal scroll
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 100 });
  const [hoveredMap, setHoveredMap] = useState<MapRegion | null>(null);
  // Number of value columns per row (default 8). Adjustable 1..MAX_COLS so a
  // full map row can be lined up; wide rows scroll horizontally.
  const MAX_VALUES_PER_ROW = 512;
  const [valuesPerRow, setValuesPerRow] = useState(columns && columns > 0 ? columns : 8);
  const [colInput, setColInput] = useState(String(columns && columns > 0 ? columns : 8));
  const valuesPerRowRef = useRef(valuesPerRow);
  valuesPerRowRef.current = valuesPerRow;
  const hoverRef = useRef(false); // pointer is over the hexdump (gates letter shortcuts)
  // Apply the persisted column count when it arrives/changes from the project
  // (does not fire on internal W/M changes — the parent only pushes it on load).
  useEffect(() => {
    if (columns != null && columns > 0) setValuesPerRow(columns);
  }, [columns]);
  // Keep the Cols field in sync when the column count changes elsewhere (W/M keys).
  useEffect(() => { setColInput(String(valuesPerRow)); }, [valuesPerRow]);
  // Commit a new column count locally and report it for persistence.
  const setColumns = useCallback((n: number) => {
    const clamped = Math.max(1, Math.min(MAX_VALUES_PER_ROW, n));
    setValuesPerRow(clamped);
    onColumnsChange?.(clamped);
  }, [onColumnsChange]);
  // W = one column narrower, M = one column wider — while the pointer is over the
  // hexdump and not typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const ae = document.activeElement as HTMLElement | null;
      if (!(hoverRef.current || (!!containerRef.current && !!ae && containerRef.current.contains(ae)))) return;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "m") { e.preventDefault(); setColumns(valuesPerRowRef.current + 1); }
      else if (k === "w") { e.preventDefault(); setColumns(valuesPerRowRef.current - 1); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setColumns]);
  // Grid alignment shift in bytes (Ctrl+←/→), kept within [0, bytesPerRow). Lets
  // the user nudge the column grid so a map's values line up to a row boundary.
  const [alignOffset, setAlignOffset] = useState(0);

  // ── Byte selection (Create map from selection) ────────────────────
  const [selectMode, setSelectMode] = useState(false);
  const [selAnchor, setSelAnchor] = useState<number | null>(null);
  const [selFocus, setSelFocus] = useState<number | null>(null);
  // Discontiguous selection (e.g. Shift+Alt+D = the modified values on screen).
  // When set it supersedes the contiguous anchor/focus range.
  const [selectedSet, setSelectedSet] = useState<Set<number> | null>(null);
  const isSelectingRef = useRef(false);
  // Inline editing state (handlers defined below, after safeFileData).
  const [editingByteOffset, setEditingByteOffset] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // Dedupes a commit fired by Enter and then again by the resulting blur.
  const committingRef = useRef(false);
  // When an edit is a BULK edit (ENTER on a selection), the value is applied to
  // every value in this frozen range instead of just the edited cell.
  const [editIsBulk, setEditIsBulk] = useState(false);
  const bulkAddrsRef = useRef<number[] | null>(null);
  const editable = displayMode === "modified" && !selectMode && !!onValueEdit;
  const bytesPerValueSel = size === "8b" ? 1 : 2;
  const selStartVal = selAnchor === null || selFocus === null ? null : Math.min(selAnchor, selFocus);
  const selEndVal = selAnchor === null || selFocus === null ? null : Math.max(selAnchor, selFocus);
  const selByteCount = selStartVal === null || selEndVal === null ? 0 : (selEndVal - selStartVal) + bytesPerValueSel;

  // Distinguishes a click (select one byte, still opens a map) from a drag
  // (select a range, and suppress the click's map-open). Set on mouse-enter
  // during a held drag, read and reset by handleByteClick.
  const draggedRef = useRef(false);
  const onCellSelectDown = useCallback((byteOffset: number) => {
    isSelectingRef.current = true;
    draggedRef.current = false;
    // Move focus into the hexdump so its keyboard shortcuts (Shift+Alt+D, Ctrl+C/
    // V, Ctrl+←/→) work immediately after a selection. The cell's preventDefault
    // otherwise leaves focus on whatever was focused before.
    scrollContentRef.current?.focus({ preventScroll: true });
    setSelectedSet(null); // a new drag replaces any discontiguous selection
    setSelAnchor(byteOffset);
    setSelFocus(byteOffset);
  }, []);
  const onCellSelectEnter = useCallback((byteOffset: number) => {
    if (isSelectingRef.current) {
      draggedRef.current = true;
      setSelFocus(byteOffset);
    }
  }, []);

  // End a drag anywhere the mouse is released.
  useEffect(() => {
    const up = () => { isSelectingRef.current = false; };
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, []);

  // Report the selection's start byte to the parent (drives "count differences
  // from the selected byte"). Fires whenever the selection start changes.
  useEffect(() => {
    onSelectionStartChange?.(selStartVal);
  }, [selStartVal, onSelectionStartChange]);

  const clearSelection = useCallback(() => {
    setSelAnchor(null);
    setSelFocus(null);
    setSelectedSet(null);
    isSelectingRef.current = false;
  }, []);

  // The selected value-start byte offsets, from the discontiguous set if present
  // (Shift+Alt+D), otherwise the contiguous anchor→focus range.
  const getSelectedAddrs = useCallback((): number[] => {
    if (selectedSet && selectedSet.size) return Array.from(selectedSet).sort((a, b) => a - b);
    if (selStartVal !== null && selEndVal !== null) {
      const bpv = size === "8b" ? 1 : 2;
      const arr: number[] = [];
      for (let a = selStartVal; a <= selEndVal; a += bpv) arr.push(a);
      return arr;
    }
    return [];
  }, [selectedSet, selStartVal, selEndVal, size]);

  // Ctrl+V: parse clipboard numbers (current format) and write them consecutively
  // from the selection start via the parent.
  const pasteAt = useCallback(async (startAddr: number) => {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { return; }
    if (!text.trim()) return;
    const bpv = size === "8b" ? 1 : 2;
    const mask = bpv === 1 ? 0xff : 0xffff;
    const values: number[] = [];
    for (const tok of text.trim().split(/[\s,;]+/)) {
      if (!tok) continue;
      const n = format === "hex" ? parseInt(tok, 16) : parseInt(tok, 10);
      if (Number.isFinite(n)) values.push(Math.max(0, Math.min(mask, n)));
    }
    if (values.length > 0) onValuesPaste?.(startAddr, values);
  }, [size, format, onValuesPaste]);

  // Commit the "Values per row" field (clamped 1..MAX).
  const applyColInput = useCallback(() => {
    const n = Math.round(Number(colInput));
    const clamped = Number.isFinite(n) && n > 0 ? Math.min(MAX_VALUES_PER_ROW, n) : valuesPerRow;
    setColumns(clamped);
    setColInput(String(clamped));
  }, [colInput, valuesPerRow, setColumns]);
  // Minimap (remplace la scrollbar) : canvas plein fichier + indicateur de
  // viewport piloté en style direct (aucun re-render au scroll)
  const minimapRef = useRef<HTMLDivElement>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement>(null);
  const minimapViewportRef = useRef<HTMLDivElement>(null);
  const [minimapSize, setMinimapSize] = useState({ w: 0, h: 0 });

  // Safely get file data length (handle undefined/null)
  const safeFileData = useMemo(() => fileData || [], [fileData]);

  // Ctrl+C: copy the selected values to the clipboard as space-separated numbers
  // in the current Hex/Dec format (16-bit values honour the byte order).
  const copySelection = useCallback(async (addrs: number[]) => {
    const bpv = size === "8b" ? 1 : 2;
    const mask = bpv === 1 ? 0xff : 0xffff;
    const parts = addrs.map((a) => {
      const v = bpv === 1 ? (safeFileData[a] ?? 0) : read16(safeFileData, a, byteOrder);
      return format === "hex" ? (v & mask).toString(16).toUpperCase() : String(v & mask);
    });
    try { await navigator.clipboard.writeText(parts.join(" ")); } catch { /* clipboard blocked */ }
  }, [safeFileData, size, byteOrder, format]);

  // Inline editing handlers (need safeFileData).
  const beginEdit = useCallback((byteOffset: number) => {
    const bpv = size === "8b" ? 1 : 2;
    const v = bpv === 1
      ? (safeFileData[byteOffset] ?? 0)
      : read16(safeFileData, byteOffset, byteOrder);
    committingRef.current = false;
    setEditDraft(format === "hex" ? v.toString(16).toUpperCase() : v.toString(10));
    setEditingByteOffset(byteOffset);
  }, [safeFileData, size, byteOrder, format]);
  const commitEdit = useCallback(() => {
    if (editingByteOffset === null || committingRef.current) return;
    committingRef.current = true;
    const parsed = format === "hex" ? parseInt(editDraft.trim(), 16) : parseInt(editDraft.trim(), 10);
    if (Number.isFinite(parsed)) {
      const max = size === "8b" ? 0xff : 0xffff;
      const val = Math.max(0, Math.min(max, parsed));
      if (editIsBulk && bulkAddrsRef.current && onValuesFill) {
        // Apply the typed value to every selected value at once.
        onValuesFill(bulkAddrsRef.current, val);
      } else if (onValueEdit) {
        onValueEdit(editingByteOffset, val);
      }
    }
    setEditIsBulk(false);
    bulkAddrsRef.current = null;
    setEditingByteOffset(null);
  }, [editingByteOffset, editDraft, format, size, onValueEdit, onValuesFill, editIsBulk]);
  // Begin a bulk edit: an input opens on the FIRST selected cell (prefilled with
  // its current value); committing writes the value to every selected value.
  const startBulkEdit = useCallback(() => {
    const addrs = getSelectedAddrs();
    if (addrs.length === 0) return;
    const first = addrs[0];
    const bpv = size === "8b" ? 1 : 2;
    const v = bpv === 1
      ? (safeFileData[first] ?? 0)
      : read16(safeFileData, first, byteOrder);
    committingRef.current = false;
    bulkAddrsRef.current = addrs;
    setEditIsBulk(true);
    setEditDraft(format === "hex" ? v.toString(16).toUpperCase() : v.toString(10));
    setEditingByteOffset(first);
  }, [getSelectedAddrs, size, byteOrder, format, safeFileData]);
  const cancelEdit = useCallback(() => {
    setEditIsBulk(false);
    bulkAddrsRef.current = null;
    committingRef.current = true;
    setEditingByteOffset(null);
  }, []);

  // ENTER, with one or more values selected, opens an editor that applies the
  // typed value to EVERY selected value. Scoped so it never hijacks typing in a
  // real input, and only when bulk editing is possible (modified view, handler
  // present, nothing already being edited).
  useEffect(() => {
    if (displayMode !== "modified" || selectMode || !onValuesFill) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (selStartVal === null || selEndVal === null) return;
      if (editingByteOffset !== null) return;
      const ae = document.activeElement as HTMLElement | null;
      // Never hijack typing in a real field, or Enter on a focused control that
      // isn't part of the hexdump (a button, a map window, etc.). After a
      // drag-select nothing is focused, so activeElement is the body.
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      if (ae && ae !== document.body && !scrollContentRef.current?.contains(ae)) return;
      e.preventDefault();
      startBulkEdit();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [displayMode, selectMode, onValuesFill, selStartVal, selEndVal, editingByteOffset, startBulkEdit]);

  // F11 restores every selected value to the original file's bytes. Same scoping
  // as the ENTER bulk-edit handler; preventDefault also stops the browser/webview
  // from toggling fullscreen.
  useEffect(() => {
    if (displayMode !== "modified" || selectMode || !onValuesRestore) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F11") return;
      if (editingByteOffset !== null) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      if (ae && ae !== document.body && !scrollContentRef.current?.contains(ae)) return;
      const addrs = getSelectedAddrs();
      if (addrs.length === 0) return;
      e.preventDefault();
      onValuesRestore(addrs);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [displayMode, selectMode, onValuesRestore, editingByteOffset, getSelectedAddrs]);

  // + / - (or = for +): add / subtract the toolbar step from every selected
  // value. Same scoping as ENTER/F11; ignores Ctrl/Meta/Alt so it never clashes
  // with the Ctrl+/- zoom or Ctrl+arrow align.
  useEffect(() => {
    // Works in Mod and % views (in % view the step is a percent of each value).
    if (displayMode === "original" || selectMode || !onValuesAdjust) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (editingByteOffset !== null) return;
      let sign: 1 | -1 | 0 = 0;
      if (e.key === "+" || e.key === "=") sign = 1;
      else if (e.key === "-" || e.key === "_") sign = -1;
      if (sign === 0) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      if (ae && ae !== document.body && !scrollContentRef.current?.contains(ae)) return;
      const addrs = getSelectedAddrs();
      if (addrs.length === 0) return;
      e.preventDefault();
      onValuesAdjust(addrs, sign);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [displayMode, selectMode, onValuesAdjust, editingByteOffset, getSelectedAddrs]);

  const fileDataLength = safeFileData.length;

  // Calculate bytes per row based on size.
  // CRITIQUE : bytesPerRow doit valoir valuesPerRow * bytesPerValue. L'ancien
  // 16 fixe en mode 8b (8 valeurs de 1 octet, adresses au pas de 16) cachait
  // UN OCTET SUR DEUX — les modifications tombant dans la moitié invisible
  // semblaient ne jamais apparaître.
  const { bytesPerValue, bytesPerRow, totalRows } = useMemo(() => {
    const bytesPerValue = size === "8b" ? 1 : 2;
    const bytesPerRow = valuesPerRow * bytesPerValue;
    // The alignment shift adds up to one extra row at the end for the bytes
    // pushed past the last row boundary.
    const totalRows = Math.ceil((fileDataLength + alignOffset) / bytesPerRow);
    return { bytesPerValue, bytesPerRow, totalRows };
  }, [size, fileDataLength, valuesPerRow, alignOffset]);

  // Keep the alignment shift valid (< bytesPerRow, value-aligned) when the word
  // size or columns change.
  useEffect(() => {
    setAlignOffset((o) => {
      const bpv = size === "8b" ? 1 : 2;
      const m = ((o % bytesPerRow) + bytesPerRow) % bytesPerRow;
      return m - (m % bpv); // snap to a whole value
    });
  }, [bytesPerRow, size]);

  // Create a map of byte address -> map info for quick lookup
  const byteToMapInfo = useMemo(() => {
    const map = new Map<number, ByteMapInfo>();

    mapRegions.forEach((region) => {
      const endAddress = region.address + region.size - 1;

      for (let addr = region.address; addr <= endAddress && addr < fileDataLength; addr++) {
        map.set(addr, {
          mapRegion: region,
          isStart: addr === region.address,
          isEnd: addr === endAddress
        });
      }
    });

    return map;
  }, [mapRegions, fileDataLength]);

  // Modifications vs fichier d'origine, au niveau des VALEURS affichées
  // (8/16 bits) : liste d'adresses + signe pour la minimap, compteurs pour le
  // header. Recalculé uniquement quand les données ou le mode changent.
  const safeOriginalData = useMemo(() => (originalFileData && originalFileData.length > 0 ? originalFileData : null), [originalFileData]);
  const diffInfo = useMemo(() => {
    const entries: { addr: number; sign: 1 | -1 }[] = [];
    let above = 0;
    let below = 0;
    if (safeOriginalData) {
      const len = Math.min(fileDataLength, safeOriginalData.length);
      const step = size === "8b" ? 1 : 2;
      for (let addr = 0; addr + step <= len; addr += step) {
        const cur = step === 1
          ? safeFileData[addr]
          : read16(safeFileData, addr, byteOrder);
        const orig = step === 1
          ? safeOriginalData[addr]
          : read16(safeOriginalData, addr, byteOrder);
        if (cur > orig) { entries.push({ addr, sign: 1 }); above++; }
        else if (cur < orig) { entries.push({ addr, sign: -1 }); below++; }
      }
    }
    return { entries, above, below };
  }, [safeFileData, safeOriginalData, fileDataLength, size, byteOrder]);

  // Report the changed-byte addresses to the parent (drives the toolbar's
  // change navigator). Fires only when the set actually changes.
  const lastDiffKey = useRef<string>("");
  useEffect(() => {
    if (!onDiffAddressesChange) return;
    const addrs = diffInfo.entries.map((e) => e.addr);
    const key = `${addrs.length}:${addrs[0] ?? -1}:${addrs[addrs.length - 1] ?? -1}`;
    if (key === lastDiffKey.current) return;
    lastDiffKey.current = key;
    onDiffAddressesChange(addrs);
  }, [diffInfo, onDiffAddressesChange]);

  // Shift+Alt+D: select the modified/different values that are currently VISIBLE
  // (the rows on screen, not the whole file). Builds a discontiguous selection.
  const selectVisibleDiffs = useCallback(() => {
    const sc = scrollContentRef.current;
    if (!sc) return;
    const firstRow = Math.floor(sc.scrollTop / ROW_HEIGHT);
    const lastRow = Math.ceil((sc.scrollTop + sc.clientHeight) / ROW_HEIGHT);
    // Map the visible rows to real file addresses through the alignment shift.
    const startAddr = firstRow * bytesPerRow - alignOffset;
    const endAddr = lastRow * bytesPerRow - alignOffset;
    const set = new Set<number>();
    let min = Infinity;
    let max = -Infinity;
    for (const e of diffInfo.entries) {
      if (e.addr >= startAddr && e.addr < endAddr) {
        set.add(e.addr);
        if (e.addr < min) min = e.addr;
        if (e.addr > max) max = e.addr;
      }
    }
    if (set.size === 0) { clearSelection(); return; }
    setSelectedSet(set);
    setSelAnchor(min); // extent, so selStartVal/onSelectionStartChange stay valid
    setSelFocus(max);
  }, [diffInfo, bytesPerRow, alignOffset, clearSelection]);

  // Ctrl+C copy, Ctrl+V paste, Shift+Alt+D select-visible-diffs. Scoped to the
  // hexdump and skipped while a real input is focused (so it keeps its own copy/
  // paste/typing).
  useEffect(() => {
    const isField = (ae: Element | null) =>
      !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || (ae as HTMLElement).isContentEditable);
    const inScope = (ae: Element | null) => !ae || ae === document.body || !!scrollContentRef.current?.contains(ae);
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement;
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyD") {
        if (displayMode !== "modified" || isField(ae) || !inScope(ae)) return;
        e.preventDefault();
        selectVisibleDiffs();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (isField(ae) || !inScope(ae)) return; // let inputs do their own copy/paste
      const k = e.key.toLowerCase();
      if (k === "c") {
        const addrs = getSelectedAddrs();
        if (addrs.length === 0) return;
        e.preventDefault();
        copySelection(addrs);
      } else if (k === "v") {
        if (displayMode !== "modified" || !onValuesPaste) return;
        const addrs = getSelectedAddrs();
        if (addrs.length === 0) return;
        e.preventDefault();
        pasteAt(addrs[0]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [displayMode, getSelectedAddrs, copySelection, pasteAt, selectVisibleDiffs, onValuesPaste]);

  // Ctrl+← / Ctrl+→ nudge the whole value grid one column left/right (view-only,
  // cyclic within a row) so a map's values can be aligned to a column boundary.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      if (ae && ae !== document.body && !scrollContentRef.current?.contains(ae)) return;
      e.preventDefault();
      const bpv = size === "8b" ? 1 : 2;
      const delta = e.key === "ArrowRight" ? bpv : -bpv;
      setAlignOffset((o) => (((o + delta) % bytesPerRow) + bytesPerRow) % bytesPerRow);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [size, bytesPerRow]);

  // Create a map of byte address -> search result info for quick lookup
  const byteToSearchInfo = useMemo(() => {
    const map = new Map<number, ByteSearchInfo>();
    const searchBytesPerValue = searchDataSize === '8b' ? 1 : 2;

    searchResults.forEach((addr, index) => {
      const isCurrent = index === currentSearchIndex;
      // Mark all bytes that belong to this search result
      for (let i = 0; i < searchBytesPerValue; i++) {
        map.set(addr + i, {
          isCurrent,
          isStart: i === 0
        });
      }
    });

    return map;
  }, [searchResults, currentSearchIndex, searchDataSize]);

  // Scroll to selected map/search result when it changes - centers the target row.
  // Deduped by an "address:scrollKey" signature so the scroll fires exactly ONCE
  // per navigation request. Without this the effect re-ran on every unrelated
  // re-render (its onScrollComplete dep is a fresh closure each render, and a
  // change-nav leaves selectedMapAddress set), so scrolling the minimap kept
  // snapping the view back to the last toggled difference.
  const lastScrollSig = useRef<string>("");
  useEffect(() => {
    if (selectedMapAddress === null || !scrollContentRef.current) {
      // Reset so re-selecting the SAME address later still triggers a scroll.
      if (selectedMapAddress === null) lastScrollSig.current = "";
      return;
    }
    const sig = `${selectedMapAddress}:${scrollKey}`;
    if (sig === lastScrollSig.current) return;
    lastScrollSig.current = sig;

    // Account for the alignment shift when locating the target's row.
    const rowIndex = Math.floor((selectedMapAddress + alignOffset) / bytesPerRow);
    const visibleHeight = scrollContentRef.current.clientHeight;
    const scrollTop = rowIndex * ROW_HEIGHT - visibleHeight / 2 + ROW_HEIGHT / 2;
    scrollContentRef.current.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });

    // Notify parent that scroll is complete (after animation). Only for a map/
    // search click (scrollKey 0); change-nav keeps its target set.
    if (onScrollComplete && scrollKey === 0) {
      setTimeout(() => {
        onScrollComplete();
      }, 500); // Wait for smooth scroll animation to complete
    }
  }, [selectedMapAddress, bytesPerRow, onScrollComplete, scrollKey, alignOffset]);

  useEffect(() => {
    const container = scrollContentRef.current;
    if (!container) return;

    // rAF-throttled: coalesce the scroll events of a frame into one range
    // computation, and quantize the range to RANGE_CHUNK rows so a state
    // update (= re-render) only happens every RANGE_CHUNK rows.
    let ticking = false;
    const updateRange = () => {
      ticking = false;
      // Keep the offset-column header aligned when rows are wider than the
      // viewport and scroll horizontally.
      if (headerColsRef.current) {
        headerColsRef.current.style.transform = `translateX(${-container.scrollLeft}px)`;
      }
      const scrollTop = container.scrollTop;
      const containerHeight = container.clientHeight;

      const rawStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
      const rawEnd = Math.min(totalRows, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN);
      const start = Math.floor(rawStart / RANGE_CHUNK) * RANGE_CHUNK;
      const end = Math.min(totalRows, Math.ceil(rawEnd / RANGE_CHUNK) * RANGE_CHUNK);

      // Indicateur de viewport de la minimap : style direct (pas de re-render),
      // dimensions lues en live pour éviter toute closure périmée.
      const vp = minimapViewportRef.current;
      const mm = minimapRef.current;
      if (vp && mm) {
        const totalH = totalRows * ROW_HEIGHT;
        const h = mm.clientHeight;
        if (totalH > 0 && h > 0) {
          const vh = Math.max(10, (containerHeight / totalH) * h);
          const top = Math.min(h - vh, (scrollTop / totalH) * h);
          vp.style.top = `${Math.max(0, top)}px`;
          vp.style.height = `${vh}px`;
        }
      }

      setVisibleRange(prev => (prev.start === start && prev.end === end) ? prev : { start, end });
    };
    const handleScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(updateRange);
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    updateRange();

    return () => container.removeEventListener('scroll', handleScroll);
  }, [totalRows, size, format]);

  // Report the grid's needed width so the host window can grow to fit when the
  // columns count (or word size) changes. Measured after layout settles.
  useEffect(() => {
    if (!onContentWidthChange) return;
    const id = requestAnimationFrame(() => {
      const el = scrollContentRef.current;
      if (el) onContentWidthChange(el.scrollWidth + MINIMAP_WIDTH + 24); // + minimap + chrome
    });
    return () => cancelAnimationFrame(id);
  }, [valuesPerRow, size, format, fileDataLength, onContentWidthChange]);

  // --- Minimap : mesure du conteneur (hauteur = zone scrollable) ---
  useEffect(() => {
    const el = minimapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setMinimapSize(prev => (prev.w === w && prev.h === h) ? prev : { w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fileDataLength]);

  // --- Minimap : dessin du fichier complet (texture WinOLS) + marques de
  // modifications. Redessiné uniquement quand les données, le thème, les
  // dimensions ou les diffs changent — jamais au scroll (le viewport est un
  // div séparé piloté en style direct).
  useEffect(() => {
    const canvas = minimapCanvasRef.current;
    if (!canvas || !minimapSize.w || !minimapSize.h || fileDataLength === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(minimapSize.w * dpr));
    const H = Math.max(1, Math.round(minimapSize.h * dpr));
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = ctx.createImageData(W, H);
    const data = img.data;
    const totalPx = W * H;
    const light = theme === 'light';

    // Texture façon WinOLS : chaque pixel représente un segment contigu du
    // fichier. Le REMPLISSAGE (runs uniformes de 0x00 ou 0xFF, très majoritaire
    // dans un dump flash) est rendu comme un fond sombre ; les zones de vraies
    // données ressortent en blocs gris, d'autant plus clairs que les valeurs
    // varient. Sans cette distinction, un dump 2 Mo rempli de FF donne une
    // dalle gris clair uniforme illisible.
    const bytesPerPx = fileDataLength / totalPx;
    for (let p = 0; p < totalPx; p++) {
      const start = Math.floor(p * bytesPerPx);
      const end = Math.min(fileDataLength, Math.max(start + 1, Math.floor((p + 1) * bytesPerPx)));
      // Jusqu'à 8 échantillons répartis dans le segment
      const sampleStep = Math.max(1, Math.floor((end - start) / 8));
      let mn = 255;
      let mx = 0;
      let sum = 0;
      let n = 0;
      for (let i = start; i < end; i += sampleStep) {
        const b = safeFileData[i] ?? 0;
        if (b < mn) mn = b;
        if (b > mx) mx = b;
        sum += b;
        n++;
      }
      const isEmpty = mn === mx && (mn === 0x00 || mn === 0xFF);
      // Luminosité ∝ valeur moyenne des octets, comme la vue d'ensemble
      // WinOLS : zones de valeurs basses sombres, valeurs hautes claires.
      // (L'ancienne heuristique à base de variance inversait des zones sur
      // EDC15 — code plein de 0x00 rendu clair.) Les runs uniformes 00/FF
      // (remplissage flash) restent rendus comme un fond neutre.
      const mean = sum / n;
      let v: number;
      if (light) {
        v = isEmpty ? 242 : Math.round(30 + mean * 0.75);
      } else {
        v = isEmpty ? 15 : Math.round(28 + mean * 0.8);
      }
      const o = p * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = light ? v : Math.min(255, v + 6); // léger biais bleu (fond #0a0b0f)
      data[o + 3] = 255;
    }

    // Marques de modifications : rouge au-dessus de l'origine, bleu en dessous
    // (pastille 2x2 pour rester visible à l'échelle du fichier entier).
    const mark = (p: number, r: number, g: number, b: number) => {
      const x = p % W;
      const y = Math.floor(p / W);
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const xx = Math.min(W - 1, x + dx);
          const yy = Math.min(H - 1, y + dy);
          const o = (yy * W + xx) * 4;
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
        }
      }
    };
    for (const { addr, sign } of diffInfo.entries) {
      const p = Math.min(totalPx - 1, Math.floor((addr / fileDataLength) * totalPx));
      if (sign > 0) mark(p, 255, 82, 82);
      else mark(p, 77, 163, 255);
    }

    ctx.putImageData(img, 0, 0);

    // Resynchroniser l'indicateur de viewport après (re)dessin/resize
    scrollContentRef.current?.dispatchEvent(new Event('scroll'));
  }, [safeFileData, fileDataLength, diffInfo, minimapSize, theme]);

  // --- Minimap : clic / glisser pour naviguer (centre le viewport) ---
  const handleMinimapMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const mm = minimapRef.current;
    const sc = scrollContentRef.current;
    if (!mm || !sc) return;
    const rect = mm.getBoundingClientRect();
    const totalH = totalRows * ROW_HEIGHT;
    const scrollTo = (clientY: number) => {
      const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      sc.scrollTop = frac * totalH - sc.clientHeight / 2;
    };
    scrollTo(e.clientY);
    const onMove = (ev: MouseEvent) => scrollTo(ev.clientY);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [totalRows]);

  const handleByteClick = useCallback((byteAddress: number) => {
    // A drag just selected a range — swallow the trailing click so it doesn't
    // also open a map. A plain click (no drag) still opens the map underneath.
    if (draggedRef.current) { draggedRef.current = false; return; }
    const mapInfo = byteToMapInfo.get(byteAddress);
    if (mapInfo && onMapClick) {
      onMapClick(mapInfo.mapRegion);
    }
  }, [byteToMapInfo, onMapClick]);

  const handleByteHover = useCallback((byteAddress: number | null) => {
    if (byteAddress === null) {
      setHoveredMap(null);
    } else {
      const mapInfo = byteToMapInfo.get(byteAddress);
      setHoveredMap(mapInfo?.mapRegion || null);
    }
  }, [byteToMapInfo]);

  const handleLabelClick = useCallback((mapRegion: MapRegion) => {
    onMapClick?.(mapRegion);
  }, [onMapClick]);

  const handleLabelHover = useCallback((mapRegion: MapRegion | null) => {
    setHoveredMap(mapRegion);
  }, []);

  const minWidth = minWidthOverride ?? (size === "8b" ? "500px" : "580px");
  const getHeaderTextColor = () => theme === 'light' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(255, 255, 255, 0.5)';
  const getBorderColor = () => theme === 'light' ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.1)';

  // Rows to render for the current window
  const rows = useMemo(() => {
    const list: number[] = [];
    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      list.push(i);
    }
    return list;
  }, [visibleRange]);

  return (
    <div
      ref={containerRef}
      className={`h-full bg-transparent flex ${theme === 'light' ? 'light-theme' : ''}`}
      style={{ width: containerWidth, minWidth, marginBottom: '16px', height: 'calc(100% - 16px)' }}
      onMouseEnter={() => { hoverRef.current = true; }}
      onMouseLeave={() => { hoverRef.current = false; }}
    >
      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <div className="p-3 pb-0">
          <div className="mb-3 pb-1 flex items-center justify-between gap-2" style={{ borderBottom: `1px solid ${getBorderColor()}` }}>
            <div className="text-[11px] flex items-center min-w-0 flex-1" style={{ color: getHeaderTextColor() }}>
              <span>
                {fileName.length > 35 ? fileName.substring(0, 30) + '...' : fileName}
              </span>
              <span className="flex-shrink-0 ml-2"> - {(fileDataLength / 1024).toFixed(2)} Ko</span>
              {mapRegions.length > 0 && (
                <span className="ml-2 text-primary flex-shrink-0">
                  • {mapRegions.length} maps
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {/* Values per row — line up a full map row, or narrow the grid. */}
              <div className="flex items-center gap-1" title="Values per row (1–512) — W narrower, M wider">
                <span className="text-[10px]" style={{ color: getHeaderTextColor() }}>Cols</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_VALUES_PER_ROW}
                  value={colInput}
                  onChange={(e) => setColInput(e.target.value)}
                  onBlur={() => applyColInput()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); applyColInput(); (e.target as HTMLInputElement).blur(); }
                    else if (e.key === 'Escape') { setColInput(String(valuesPerRow)); (e.target as HTMLInputElement).blur(); }
                    e.stopPropagation();
                  }}
                  className="w-12 text-center font-mono text-[11px] rounded outline-none"
                  style={{
                    background: theme === 'light' ? '#fff' : 'rgba(255,255,255,0.06)',
                    color: theme === 'light' ? '#000' : '#fff',
                    border: `1px solid ${theme === 'light' ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)'}`,
                    padding: '2px 4px',
                  }}
                />
              </div>
              {alignOffset !== 0 && (
                <button
                  onClick={() => setAlignOffset(0)}
                  title="Grid shifted for alignment (Ctrl+←/→) — click to reset"
                  className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                  style={{
                    color: theme === 'light' ? '#b45309' : '#fbbf24',
                    background: theme === 'light' ? 'rgba(245,158,11,0.12)' : 'rgba(245,158,11,0.18)',
                    border: '1px solid rgba(245,158,11,0.45)',
                  }}
                >
                  ⇄ +{alignOffset}
                </button>
              )}
              {selectMode && selByteCount === 0 && (
                <span className="text-[10px]" style={{ color: getHeaderTextColor() }}>Drag to select</span>
              )}
              {onCreateMapFromSelection && selectMode && selByteCount > 0 && (
                <button
                  onClick={() => {
                    if (selStartVal !== null) onCreateMapFromSelection(selStartVal, selByteCount);
                    clearSelection();
                    setSelectMode(false);
                  }}
                  className="text-[11px] px-3 py-1 rounded font-medium transition-colors"
                  style={{
                    color: '#ffffff',
                    background: 'linear-gradient(90deg, rgba(220,38,38,0.9), rgba(249,115,22,0.9))',
                    border: '1px solid rgba(255,255,255,0.15)',
                  }}
                >
                  {createMapLabel} ({selByteCount} B)
                </button>
              )}
              {onCreateMapFromSelection && (
                <button
                  onClick={() => { setSelectMode((m) => !m); clearSelection(); }}
                  className="text-[11px] px-3 py-1 rounded font-medium transition-colors"
                  style={{
                    color: selectMode ? '#ffffff' : (theme === 'light' ? '#000000' : '#ffffff'),
                    background: selectMode ? 'rgba(47,95,176,0.85)' : (theme === 'light' ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.06)'),
                    border: `1px solid ${theme === 'light' ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)'}`,
                  }}
                  title={selectMode ? 'Cancel selection' : 'Select bytes to create a map'}
                >
                  {selectMode ? 'Cancel' : createMapLabel}
                </button>
              )}
              {onSearchClick && (
                <button
                  onClick={onSearchClick}
                  className="text-[11px] px-3 py-1 rounded font-medium transition-colors duration-200 hover:bg-yellow-500/50"
                  style={{
                    color: theme === 'light' ? '#000000' : '#ffffff',
                    background: theme === 'light' ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.06)',
                    border: `1px solid ${theme === 'light' ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)'}`,
                  }}
                >
                  {searchButtonLabel}
                </button>
              )}
            </div>
          </div>

        </div>

        {/* Offset column header (aligné sur la grille des valeurs) */}
        <div
          className="flex gap-3 font-mono text-[10px] px-3 pb-1 select-none flex-shrink-0"
          style={{ color: getHeaderTextColor(), overflow: 'hidden' }}
        >
          <div className="flex-shrink-0 font-semibold" style={{ width: '3rem' }}>Offset</div>
          <div className="flex flex-shrink-0" ref={headerColsRef} style={{ willChange: 'transform' }}>
            {Array.from({ length: valuesPerRow }, (_, j) => (
              <div
                key={j}
                className="text-center"
                style={{ width: size === "16b" ? '2.4rem' : '1.85rem', marginRight: '2px' }}
              >
                {(j * bytesPerValue).toString(16).toUpperCase().padStart(2, '0')}
              </div>
            ))}
          </div>
        </div>

        {/* Scrollable content + minimap */}
        <div className="flex-1 flex min-h-0">
        <div
          ref={scrollContentRef}
          tabIndex={-1}
          className={`flex-1 overflow-auto px-3 pb-3 hexdump-noscrollbar outline-none ${theme === 'light' ? 'light-theme' : ''}`}
        >
          {/* Virtualized content */}
          <div
            className="relative"
            style={{ height: `${totalRows * ROW_HEIGHT}px` }}
          >
            {rows.map((rowIndex) => {
              // Pass the hovered map to a row ONLY when it intersects it, so
              // hover changes re-render just the concerned rows and the memo
              // keeps every other row untouched.
              const startByte = rowIndex * bytesPerRow;
              const endByte = startByte + bytesPerRow - 1;
              const rowHoveredMap =
                hoveredMap &&
                hoveredMap.address <= endByte &&
                hoveredMap.address + hoveredMap.size - 1 >= startByte
                  ? hoveredMap
                  : null;

              return (
                <HexRow
                  key={rowIndex}
                  rowIndex={rowIndex}
                  fileData={safeFileData}
                  originalFileData={safeOriginalData}
                  fileDataLength={fileDataLength}
                  size={size}
                  byteOrder={byteOrder}
                  format={format}
                  theme={theme}
                  bytesPerValue={bytesPerValue}
                  valuesPerRow={valuesPerRow}
                  bytesPerRow={bytesPerRow}
                  displayMode={displayMode}
                  byteToMapInfo={byteToMapInfo}
                  byteToSearchInfo={byteToSearchInfo}
                  hoveredMap={rowHoveredMap}
                  selectMode={selectMode}
                  selStartVal={selStartVal}
                  selEndVal={selEndVal}
                  selectedSet={selectedSet}
                  alignOffset={alignOffset}
                  currentChangeAddress={currentChangeAddress}
                  onByteClick={handleByteClick}
                  onByteHover={handleByteHover}
                  onLabelClick={handleLabelClick}
                  onLabelHover={handleLabelHover}
                  onCellSelectDown={onCellSelectDown}
                  onCellSelectEnter={onCellSelectEnter}
                  editable={editable}
                  editingByteOffset={
                    editingByteOffset !== null &&
                    editingByteOffset >= rowIndex * bytesPerRow &&
                    editingByteOffset < (rowIndex + 1) * bytesPerRow
                      ? editingByteOffset
                      : -1
                  }
                  editDraft={
                    editingByteOffset !== null &&
                    editingByteOffset >= rowIndex * bytesPerRow &&
                    editingByteOffset < (rowIndex + 1) * bytesPerRow
                      ? editDraft
                      : ''
                  }
                  onEditStart={beginEdit}
                  onEditChange={setEditDraft}
                  onEditCommit={commitEdit}
                  onEditCancel={cancelEdit}
                />
              );
            })}
          </div>
        </div>

        {/* Minimap du fichier (remplace la scrollbar) : vue d'ensemble du
            binaire, marques rouge/bleu des modifications, viewport draggable */}
        {fileDataLength > 0 && (
          <div
            ref={minimapRef}
            onMouseDown={handleMinimapMouseDown}
            className="flex-shrink-0 relative select-none mb-3 mr-2 rounded-md overflow-hidden"
            style={{
              width: `${MINIMAP_WIDTH}px`,
              border: `1px solid ${getBorderColor()}`,
              cursor: 'pointer',
              backgroundColor: theme === 'light' ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.03)',
            }}
            title="Vue d'ensemble du fichier — cliquer / glisser pour naviguer"
          >
            <canvas
              ref={minimapCanvasRef}
              className="absolute inset-0 w-full h-full"
              style={{ imageRendering: 'pixelated' }}
            />
            {/* Indicateur de viewport (position pilotée en style direct) —
                teinte rouge dégradée, même identité que le reste de l'app */}
            <div
              ref={minimapViewportRef}
              className="absolute left-0 right-0 pointer-events-none rounded-[3px]"
              style={{
                top: 0,
                height: 24,
                border: theme === 'light' ? '1px solid rgba(220,38,38,0.55)' : '1px solid rgba(239,68,68,0.6)',
                background: theme === 'light'
                  ? 'linear-gradient(135deg, rgba(220,38,38,0.18), rgba(249,115,22,0.12))'
                  : 'linear-gradient(135deg, rgba(220,38,38,0.3), rgba(249,115,22,0.2))',
                boxShadow: theme === 'light' ? '0 0 0 1px rgba(255,255,255,0.5)' : '0 0 0 1px rgba(0,0,0,0.45)',
              }}
            />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
