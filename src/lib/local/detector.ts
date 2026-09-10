// Detection engine access — Tauri IPC wrappers.
// The Rust detection code lives in src-tauri/src/detector/ and is exposed
// through the commands in src-tauri/src/commands.rs. Response shapes are
// identical to the old map-detector HTTP microservice.

import { invoke } from "@tauri-apps/api/core";

export interface EcuIdentification {
  manufacturer: string;
  ecu_type: string;
  variant?: string;
  software_version?: string;
  hardware_version?: string;
  part_number?: string;
  confidence: number;
}

export interface DetectionResults {
  success: boolean;
  maps: any[];
  total_maps: number;
  processing_time_ms: number;
  file_size: number;
  /** Version du moteur ayant produit ce résultat (voir detectorVersion). */
  detector_version?: number;
  /** Rapport de complétude EDC16 : familles attendues vs trouvées. */
  expected_maps?: { label: string; expected: number; found: number }[];
}

/** ECU families the local app supports (must match src-tauri/ecus.json). */
export const SUPPORTED_ECUS = new Set([
  "EDC15P",
  "EDC15V",
  "EDC15VM",
  "EDC16U1",
  "EDC16U31",
  "EDC16U34",
]);

/**
 * BETA families: identified with confidence, but with no dedicated per-family
 * detector — their maps come from the generic potential-maps scanner. A project
 * created for one of these keeps its real ECU type (so versioning identity
 * checks pass) rather than the anonymous "unknown". EDC17 (BMW etc.) is the
 * first; the Rust identifier tags it from its "EDC17_..." metadata string.
 */
export const BETA_ECUS = new Set(["EDC17C"]);

/** True for an ECU type that can be imported and scanned (supported or beta). */
export function isImportableEcu(ecuType?: string): boolean {
  return !!ecuType && (SUPPORTED_ECUS.has(ecuType) || BETA_ECUS.has(ecuType));
}

export async function identifyEcu(
  fileDataBase64: string,
  fileName: string
): Promise<EcuIdentification> {
  return invoke<EcuIdentification>("identify_ecu", {
    fileDataBase64,
    fileName,
  });
}

export async function detectMaps(args: {
  fileDataBase64: string;
  fileName: string;
  ecuType?: string;
  tunedMode?: boolean;
}): Promise<DetectionResults> {
  return invoke<DetectionResults>("detect_maps", {
    request: {
      file_data_base64: args.fileDataBase64,
      file_name: args.fileName,
      ecu_type: args.ecuType,
      tuned_mode: args.tunedMode ?? false,
    },
  });
}

/**
 * Family-agnostic heuristic scan for CANDIDATE tables ("potential maps").
 * Used for files the strict identifier does not recognize: the returned maps
 * are guesses (low confidence, raw 16-bit values), meant to be shown only as
 * highlighted regions in the hexdump — never mixed into a recognized ECU's
 * trusted detection. Mirrors detectMaps but calls the scan_potential_maps
 * command and ignores ecuType/tunedMode.
 */
export async function scanPotentialMaps(args: {
  fileDataBase64: string;
  fileName: string;
}): Promise<DetectionResults> {
  return invoke<DetectionResults>("scan_potential_maps", {
    request: {
      file_data_base64: args.fileDataBase64,
      file_name: args.fileName,
      ecu_type: undefined,
      tuned_mode: false,
    },
  });
}

/**
 * Re-scan for candidate tables restricted to the ECU's MAP area only.
 * Same heuristic as scanPotentialMaps, but the Rust side skips the leading
 * program/code region and the trailing flash-fill and scans only the
 * calibration/data region in between (see generic::map_area_for). Pass the
 * project's ecuType so the family map-area rule applies — "EDC17C" is the first
 * family with a rule; an unknown family scans from the start (fill trimmed).
 */
export async function scanPotentialMapsInArea(args: {
  fileDataBase64: string;
  fileName: string;
  ecuType?: string;
}): Promise<DetectionResults> {
  return invoke<DetectionResults>("scan_potential_maps_in_area", {
    request: {
      file_data_base64: args.fileDataBase64,
      file_name: args.fileName,
      ecu_type: args.ecuType,
      tuned_mode: false,
    },
  });
}

export async function listEcus(): Promise<{ ecus: any[]; total: number; version: string }> {
  return invoke("list_ecus");
}

/**
 * Version courante du moteur de détection. Un projet dont les résultats
 * portent une version antérieure est re-scanné à l'ouverture : sans ça il
 * resterait indéfiniment sur des adresses, facteurs ou libellés périmés.
 */
export async function detectorVersion(): Promise<number> {
  try {
    return await invoke<number>("detector_version");
  } catch {
    // Version antérieure à l'ajout de la commande : on ne force rien.
    return 0;
  }
}

/** Encode a byte array to base64 (chunked — fast for 2MB dumps). */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}
