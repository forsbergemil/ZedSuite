"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { MODAL_GLASS, MODAL_GLASS_LIGHT } from "@/lib/modal-glass";

// A user-defined map, shaped like a detection `MapData` so it opens in the
// normal map viewer and highlights in the hexdump.
export interface CreatedMap {
  id: string;
  name: string;
  address: number;
  size: number;
  dimensions:
    | { TwoDimensional: { rows: number; cols: number } }
    | { OneDimensional: { length: number } };
  data_type: string;
  is_little_endian?: boolean;
  confidence: number;
  category: string;
  description?: string;
  correction_factor?: number;
  offset?: number;
  unit?: string;
  x_axis_address?: number;
  y_axis_address?: number;
}

/** Seed values for the form, e.g. from a hexdump byte selection. */
export interface CreateMapPrefill {
  address?: number;
  bits?: 8 | 16;
  /** When set, the form opens as a 1D curve of this length. */
  length?: number;
  littleEndian?: boolean;
}

interface CreateMapModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (map: CreatedMap) => void;
  theme: "default" | "light" | "oled";
  /** Byte order the hexdump is currently using — the create form defaults to it. */
  defaultLittleEndian: boolean;
  /** File length in bytes, to validate that the map fits. */
  fileSize: number;
  /** Seed values (address / size / length / endianness), e.g. from a selection. */
  prefill?: CreateMapPrefill;
}

type Kind = "2d" | "1d" | "value";

/** Parse a hex string ("1A2B" or "0x1A2B") to a number, or null if invalid. */
function parseHex(s: string): number | null {
  const t = s.trim().replace(/^0x/i, "");
  if (t === "" || !/^[0-9a-fA-F]+$/.test(t)) return null;
  const n = parseInt(t, 16);
  return Number.isFinite(n) ? n : null;
}

/** Parse a decimal float, or null when the field is empty/invalid. */
function parseNum(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function CreateMapModal({
  isOpen,
  onClose,
  onCreate,
  theme,
  defaultLittleEndian,
  fileSize,
  prefill,
}: CreateMapModalProps) {
  const L = theme === "light";
  // State is seeded from `prefill` on mount. The editor mounts this modal fresh
  // each time it opens, so a new selection re-seeds the form.
  const [name, setName] = useState("");
  const [addressHex, setAddressHex] = useState(
    prefill?.address !== undefined ? prefill.address.toString(16).toUpperCase() : ""
  );
  const [kind, setKind] = useState<Kind>(prefill?.length !== undefined ? "1d" : "2d");
  const [rows, setRows] = useState("16");
  const [cols, setCols] = useState("16");
  const [length, setLength] = useState(prefill?.length !== undefined ? String(prefill.length) : "16");
  const [bits, setBits] = useState<8 | 16>(prefill?.bits ?? 16);
  const [signed, setSigned] = useState(false);
  const [littleEndian, setLittleEndian] = useState(prefill?.littleEndian ?? defaultLittleEndian);
  const [factorStr, setFactorStr] = useState("");
  const [offsetStr, setOffsetStr] = useState("");
  const [unit, setUnit] = useState("");
  const [xAxisHex, setXAxisHex] = useState("");
  const [yAxisHex, setYAxisHex] = useState("");

  const inputCls = `w-full px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-0 ${
    L
      ? "bg-black/[0.05] border border-black/20 text-slate-900 placeholder:text-black/40"
      : "bg-black/20 border border-white/20 text-white placeholder:text-white/40"
  }`;
  const labelCls = `block text-xs font-medium mb-1 ${L ? "text-slate-700" : "text-white/80"}`;

  // Derived geometry + validation
  const derived = useMemo(() => {
    const address = parseHex(addressHex);
    const bpv = bits === 8 ? 1 : 2;
    let count = 0;
    if (kind === "2d") count = (parseInt(rows, 10) || 0) * (parseInt(cols, 10) || 0);
    else if (kind === "1d") count = parseInt(length, 10) || 0;
    else count = 1;
    const size = count * bpv;

    let err: string | null = null;
    if (address === null) err = "Enter a valid hexadecimal address.";
    else if (count <= 0) err = "Dimensions must be greater than zero.";
    else if (bits === 16 && address % 2 !== 0) err = "16-bit maps must start on an even address.";
    else if (address + size > fileSize) err = `Map runs past the end of the file (0x${(fileSize).toString(16).toUpperCase()}).`;

    const xAxis = xAxisHex.trim() ? parseHex(xAxisHex) : null;
    const yAxis = yAxisHex.trim() ? parseHex(yAxisHex) : null;
    if (!err && xAxisHex.trim() && xAxis === null) err = "X axis address is not valid hex.";
    if (!err && yAxisHex.trim() && yAxis === null) err = "Y axis address is not valid hex.";

    return { address, size, count, xAxis, yAxis, err };
  }, [addressHex, bits, kind, rows, cols, length, fileSize, xAxisHex, yAxisHex]);

  if (!isOpen) return null;

  const submit = () => {
    if (derived.err || derived.address === null) return;
    const bpv = bits === 8 ? 1 : 2;
    const dimensions =
      kind === "2d"
        ? { TwoDimensional: { rows: parseInt(rows, 10), cols: parseInt(cols, 10) } }
        : kind === "1d"
          ? { OneDimensional: { length: parseInt(length, 10) } }
          : { OneDimensional: { length: 1 } };
    const data_type =
      bits === 8 ? (signed ? "Int8" : "UInt8") : signed ? "Int16" : "UInt16";
    const factor = parseNum(factorStr);
    const off = parseNum(offsetStr);

    const map: CreatedMap = {
      id: (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : `custom-${derived.address}-${Date.now()}`,
      name: name.trim() || `Custom map @0x${derived.address.toString(16).toUpperCase()}`,
      address: derived.address,
      size: derived.count * bpv,
      dimensions,
      data_type,
      is_little_endian: littleEndian,
      confidence: 1,
      category: "My Maps",
      description: "User-created map",
      ...(factor !== null ? { correction_factor: factor } : {}),
      ...(off !== null ? { offset: off } : {}),
      ...(unit.trim() ? { unit: unit.trim() } : {}),
      ...(derived.xAxis !== null ? { x_axis_address: derived.xAxis } : {}),
      ...(derived.yAxis !== null ? { y_axis_address: derived.yAxis } : {}),
    };
    onCreate(map);
  };

  const radioRow = (
    options: { label: string; value: string; active: boolean; onClick: () => void }[]
  ) => (
    <div className="flex gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={o.onClick}
          className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            o.active
              ? "bg-gradient-to-r from-red-600/90 via-red-500/90 to-orange-500/90 text-white border-transparent"
              : L
                ? "bg-black/[0.03] border-black/15 text-slate-700 hover:bg-black/[0.06]"
                : "bg-black/20 border-white/15 text-white/80 hover:bg-white/10"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-xl border p-5 max-h-[90vh] overflow-y-auto"
        style={L ? MODAL_GLASS_LIGHT : MODAL_GLASS}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className={`text-lg font-bold ${L ? "text-slate-900" : "text-white"}`}>Create a map</h3>
          <button
            onClick={onClose}
            className={`p-1 rounded transition-colors ${L ? "hover:bg-black/10 text-slate-500" : "hover:bg-white/10 text-white/60"}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className={labelCls}>Name</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My boost map" spellCheck={false} />
          </div>

          <div>
            <label className={labelCls}>Start address (hex)</label>
            <input className={`${inputCls} font-mono`} value={addressHex} onChange={(e) => setAddressHex(e.target.value)} placeholder="1A2B0" spellCheck={false} />
          </div>

          <div>
            <label className={labelCls}>Shape</label>
            {radioRow([
              { label: "2D table", value: "2d", active: kind === "2d", onClick: () => setKind("2d") },
              { label: "1D curve", value: "1d", active: kind === "1d", onClick: () => setKind("1d") },
              { label: "Single value", value: "value", active: kind === "value", onClick: () => setKind("value") },
            ])}
          </div>

          {kind === "2d" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Rows (Y)</label>
                <input className={inputCls} type="number" min={1} value={rows} onChange={(e) => setRows(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Columns (X)</label>
                <input className={inputCls} type="number" min={1} value={cols} onChange={(e) => setCols(e.target.value)} />
              </div>
            </div>
          )}
          {kind === "1d" && (
            <div>
              <label className={labelCls}>Length</label>
              <input className={inputCls} type="number" min={1} value={length} onChange={(e) => setLength(e.target.value)} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Value size</label>
              {radioRow([
                { label: "8-bit", value: "8", active: bits === 8, onClick: () => setBits(8) },
                { label: "16-bit", value: "16", active: bits === 16, onClick: () => setBits(16) },
              ])}
            </div>
            <div>
              <label className={labelCls}>Sign</label>
              {radioRow([
                { label: "Unsigned", value: "u", active: !signed, onClick: () => setSigned(false) },
                { label: "Signed", value: "s", active: signed, onClick: () => setSigned(true) },
              ])}
            </div>
          </div>

          {bits === 16 && (
            <div>
              <label className={labelCls}>Byte order</label>
              {radioRow([
                { label: "Big-endian (HiLo)", value: "hilo", active: !littleEndian, onClick: () => setLittleEndian(false) },
                { label: "Little-endian (LoHi)", value: "lohi", active: littleEndian, onClick: () => setLittleEndian(true) },
              ])}
            </div>
          )}

          {/* Optional display fields */}
          <div className={`pt-2 mt-1 border-t ${L ? "border-black/10" : "border-white/10"}`}>
            <p className={`text-[11px] mb-2 ${L ? "text-slate-500" : "text-white/50"}`}>Optional — for correct display</p>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls}>Factor</label>
                <input className={inputCls} value={factorStr} onChange={(e) => setFactorStr(e.target.value)} placeholder="1" spellCheck={false} />
              </div>
              <div>
                <label className={labelCls}>Offset</label>
                <input className={inputCls} value={offsetStr} onChange={(e) => setOffsetStr(e.target.value)} placeholder="0" spellCheck={false} />
              </div>
              <div>
                <label className={labelCls}>Unit</label>
                <input className={inputCls} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="mbar" spellCheck={false} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div>
                <label className={labelCls}>X axis addr (hex)</label>
                <input className={`${inputCls} font-mono`} value={xAxisHex} onChange={(e) => setXAxisHex(e.target.value)} placeholder="—" spellCheck={false} />
              </div>
              <div>
                <label className={labelCls}>Y axis addr (hex)</label>
                <input className={`${inputCls} font-mono`} value={yAxisHex} onChange={(e) => setYAxisHex(e.target.value)} placeholder="—" spellCheck={false} />
              </div>
            </div>
          </div>

          {/* Summary / error */}
          <div className="text-[11px] min-h-[16px]">
            {derived.err ? (
              <span className="text-red-400">{derived.err}</span>
            ) : (
              derived.address !== null && (
                <span className={L ? "text-slate-500" : "text-white/50"}>
                  {derived.size} bytes · 0x{derived.address.toString(16).toUpperCase()} – 0x{(derived.address + derived.size).toString(16).toUpperCase()}
                </span>
              )
            )}
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className={`flex-1 ${L ? "" : "text-white border-white/20"}`} onClick={onClose}>
              Cancel
            </Button>
            <Button
              className="flex-1 bg-gradient-to-r from-red-600/90 via-red-500/90 to-orange-500/90 text-white"
              disabled={!!derived.err || derived.address === null}
              onClick={submit}
            >
              Create map
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
