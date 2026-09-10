// Local project store — replaces PocketBase from the web version.
// Everything lives on disk in the app data directory:
//
//   %APPDATA%/com.zedsuite.app/
//     projects/
//       <fileId>/
//         project.json          FileRecord (metadata + detection results)
//         original.bin          the imported binary, byte for byte
//         versions.json         Version[] (the "Ori" + user versions)
//         edits-<versionId>.json  MapEdit[] of one version
//
// All functions are async and go through the Tauri fs plugin, so they only
// work inside the Tauri webview (not in a plain browser tab).

import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { FileRecord, MapEdit, Version } from "@/lib/types";

/** Open a project's folder in the Windows Explorer. */
export async function openProjectDir(fileId: string): Promise<void> {
  return invoke("open_project_dir", { fileId });
}

/** Total size in bytes of the projects folder (every project and version). */
export async function projectsDirSize(): Promise<number> {
  return invoke<number>("projects_dir_size");
}

const BASE = { baseDir: BaseDirectory.AppData };
const PROJECTS_DIR = "projects";

function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  // PocketBase-style 15-char lowercase alphanumeric id
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const rand = new Uint8Array(15);
  crypto.getRandomValues(rand);
  for (let i = 0; i < 15; i++) id += chars[rand[i] % chars.length];
  return id;
}

async function ensureProjectsDir(): Promise<void> {
  if (!(await exists(PROJECTS_DIR, BASE))) {
    await mkdir(PROJECTS_DIR, { ...BASE, recursive: true });
  }
}

function projectDir(fileId: string): string {
  return `${PROJECTS_DIR}/${fileId}`;
}

// ── Files (projects) ──────────────────────────────────────────────

export async function listFiles(): Promise<FileRecord[]> {
  await ensureProjectsDir();
  const entries = await readDir(PROJECTS_DIR, BASE);
  const files: FileRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    try {
      const raw = await readTextFile(`${projectDir(entry.name)}/project.json`, BASE);
      files.push(JSON.parse(raw) as FileRecord);
    } catch {
      // Skip unreadable/corrupted project folders instead of failing the list
    }
  }
  files.sort((a, b) => (b.created > a.created ? 1 : -1));
  return files;
}

export async function getFile(fileId: string): Promise<FileRecord | null> {
  try {
    const raw = await readTextFile(`${projectDir(fileId)}/project.json`, BASE);
    return JSON.parse(raw) as FileRecord;
  } catch {
    return null;
  }
}

async function saveFileRecord(record: FileRecord): Promise<void> {
  record.updated = nowIso();
  await writeTextFile(
    `${projectDir(record.id)}/project.json`,
    JSON.stringify(record, null, 2),
    BASE
  );
}

// Serialize the read-modify-write of each project.json: independent updateFile
// calls (e.g. saving detection_data and map_display_settings at the same time)
// must not race, or the second — reading a stale record — clobbers the first's
// field. One promise chain per fileId keeps them in order.
const fileWriteQueues = new Map<string, Promise<unknown>>();

export async function updateFile(
  fileId: string,
  patch: Partial<FileRecord>
): Promise<FileRecord | null> {
  const previous = fileWriteQueues.get(fileId) ?? Promise.resolve();
  let result: FileRecord | null = null;
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const record = await getFile(fileId);
      if (!record) {
        result = null;
        return;
      }
      Object.assign(record, patch, { id: record.id, created: record.created });
      await saveFileRecord(record);
      result = record;
    });
  fileWriteQueues.set(fileId, run);
  try {
    await run;
  } finally {
    if (fileWriteQueues.get(fileId) === run) fileWriteQueues.delete(fileId);
  }
  return result;
}

export async function deleteFile(fileId: string): Promise<boolean> {
  const dir = projectDir(fileId);
  if (!(await exists(dir, BASE))) return false;
  await remove(dir, { ...BASE, recursive: true });
  return true;
}

export async function readBinary(fileId: string): Promise<Uint8Array | null> {
  try {
    return await readFile(`${projectDir(fileId)}/original.bin`, BASE);
  } catch {
    return null;
  }
}

export interface CreateProjectInput {
  fileName: string;
  originalName?: string;
  projectName?: string;
  binary: Uint8Array;
  ecuType?: string;
  hardwareVersion?: string;
  softwareVersion?: string;
  detectionResults?: any;
  vehicleBrand?: string;
  vehicleModel?: string;
  engineType?: string;
  transmissionType?: string;
  year?: string;
  power?: string;
  customer?: string;
  stage?: string;
  date?: string;
  notes?: string;
}

export async function createProject(input: CreateProjectInput): Promise<{
  file: FileRecord;
  oriVersion: Version;
}> {
  await ensureProjectsDir();
  const id = newId();
  const created = nowIso();
  const ext = input.fileName.includes(".")
    ? input.fileName.split(".").pop()!.toLowerCase()
    : "bin";

  const record: FileRecord = {
    id,
    file_name: input.fileName,
    original_name: input.originalName || input.fileName,
    project_name: input.projectName,
    file_size: input.binary.length,
    file_type: ext,
    ecu_type: input.ecuType,
    hardware_version: input.hardwareVersion,
    software_version: input.softwareVersion,
    status: "completed",
    maps_detected:
      typeof input.detectionResults?.total_maps === "number"
        ? input.detectionResults.total_maps
        : 0,
    detection_data: input.detectionResults ?? {},
    vehicle_brand: input.vehicleBrand,
    vehicle_model: input.vehicleModel,
    engine_type: input.engineType,
    transmission_type: input.transmissionType,
    year: input.year,
    power: input.power,
    customer: input.customer,
    stage: input.stage,
    date: input.date,
    notes: input.notes,
    created,
    updated: created,
  };

  const oriVersion: Version = {
    id: newId(),
    file: id,
    name: "Ori",
    is_current: true,
    base_version: null,
    created,
  };

  // Transactional: a half-written project folder (no project.json) would be
  // invisible but leak disk space — clean it up if any write fails.
  try {
    await mkdir(projectDir(id), { ...BASE, recursive: true });
    await writeFile(`${projectDir(id)}/original.bin`, input.binary, BASE);
    await writeVersions(id, [oriVersion]);
    await writeTextFile(
      `${projectDir(id)}/project.json`,
      JSON.stringify(record, null, 2),
      BASE
    );
  } catch (e) {
    try {
      await remove(projectDir(id), { ...BASE, recursive: true });
    } catch {
      // best effort cleanup
    }
    throw e;
  }

  return { file: record, oriVersion };
}

// ── Versions ──────────────────────────────────────────────────────

export async function listVersions(fileId: string): Promise<Version[]> {
  try {
    const raw = await readTextFile(`${projectDir(fileId)}/versions.json`, BASE);
    return JSON.parse(raw) as Version[];
  } catch {
    return [];
  }
}

async function writeVersions(fileId: string, versions: Version[]): Promise<void> {
  await writeTextFile(
    `${projectDir(fileId)}/versions.json`,
    JSON.stringify(versions, null, 2),
    BASE
  );
}

export async function createVersion(
  fileId: string,
  name: string,
  baseVersionId?: string | null,
  setCurrent: boolean = true
): Promise<Version | null> {
  const versions = await listVersions(fileId);
  if (versions.length === 0 && !(await getFile(fileId))) return null;
  if (setCurrent) {
    for (const v of versions) v.is_current = false;
  }
  const version: Version = {
    id: newId(),
    file: fileId,
    name,
    is_current: setCurrent,
    base_version: baseVersionId || null,
    created: nowIso(),
  };
  versions.push(version);
  await writeVersions(fileId, versions);
  return version;
}

/** Find which project folder owns a version (versions carry their file id). */
async function findVersion(
  versionId: string
): Promise<{ fileId: string; versions: Version[]; version: Version } | null> {
  await ensureProjectsDir();
  const entries = await readDir(PROJECTS_DIR, BASE);
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const versions = await listVersions(entry.name);
    const version = versions.find((v) => v.id === versionId);
    if (version) return { fileId: entry.name, versions, version };
  }
  return null;
}

export async function updateVersion(
  versionId: string,
  patch: { name?: string; is_current?: boolean }
): Promise<Version | null> {
  const found = await findVersion(versionId);
  if (!found) return null;
  const { fileId, versions, version } = found;
  if (patch.is_current === true) {
    for (const v of versions) v.is_current = v.id === versionId;
  } else if (patch.is_current === false) {
    version.is_current = false;
  }
  if (patch.name !== undefined) version.name = patch.name;
  await writeVersions(fileId, versions);
  return version;
}

// ── Imported version binaries ─────────────────────────────────────
// A version created by importing a file keeps that file on disk as
// `version-<id>.bin` in the project folder. Without it the imported bytes
// only lived in memory and the version reopened on the original file.

export async function writeVersionBinary(
  versionId: string,
  bytes: Uint8Array
): Promise<void> {
  const found = await findVersion(versionId);
  if (!found) throw new Error("version_not_found");
  await writeFile(`${projectDir(found.fileId)}/version-${versionId}.bin`, bytes, BASE);
}

export async function readVersionBinary(
  versionId: string
): Promise<Uint8Array | null> {
  const found = await findVersion(versionId);
  if (!found) return null;
  const path = `${projectDir(found.fileId)}/version-${versionId}.bin`;
  if (!(await exists(path, BASE))) return null;
  return await readFile(path, BASE);
}

// Maps that only exist in an imported version: the codeblocks a multimap
// adds on top of the original file. Kept as `version-<id>-maps.json` and
// merged into the map list only while that version is open.
export async function writeVersionExtraMaps(
  versionId: string,
  maps: unknown[]
): Promise<void> {
  const found = await findVersion(versionId);
  if (!found) throw new Error("version_not_found");
  await writeTextFile(
    `${projectDir(found.fileId)}/version-${versionId}-maps.json`,
    JSON.stringify(maps),
    BASE
  );
}

export async function readVersionExtraMaps(
  versionId: string
): Promise<unknown[] | null> {
  const found = await findVersion(versionId);
  if (!found) return null;
  const path = `${projectDir(found.fileId)}/version-${versionId}-maps.json`;
  if (!(await exists(path, BASE))) return null;
  try {
    const parsed = JSON.parse(await readTextFile(path, BASE));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function deleteVersion(
  versionId: string
): Promise<{ ok: boolean; error?: string }> {
  const found = await findVersion(versionId);
  if (!found) return { ok: false, error: "not_found" };
  const { fileId, versions, version } = found;
  if (version.name === "Ori") return { ok: false, error: "cannot_delete_ori" };
  if (versions.length <= 1) return { ok: false, error: "last_version" };

  const remaining = versions.filter((v) => v.id !== versionId);
  if (version.is_current && remaining.length > 0) {
    // Promote the most recent remaining version
    remaining.reduce((a, b) => (a.created > b.created ? a : b)).is_current = true;
  }
  await writeVersions(fileId, remaining);
  try {
    await remove(`${projectDir(fileId)}/edits-${versionId}.json`, BASE);
  } catch {
    // No edits file for this version — nothing to clean up
  }
  try {
    await remove(`${projectDir(fileId)}/version-${versionId}.bin`, BASE);
  } catch {
    // Not an imported version — no binary to clean up
  }
  try {
    await remove(`${projectDir(fileId)}/version-${versionId}-maps.json`, BASE);
  } catch {
    // No extra maps for this version
  }
  return { ok: true };
}

// ── Map edits ─────────────────────────────────────────────────────

export async function listMapEdits(versionId: string): Promise<MapEdit[]> {
  const found = await findVersion(versionId);
  if (!found) return [];
  try {
    const raw = await readTextFile(
      `${projectDir(found.fileId)}/edits-${versionId}.json`,
      BASE
    );
    return JSON.parse(raw) as MapEdit[];
  } catch {
    return [];
  }
}

// Écritures SÉRIALISÉES par version : l'éditeur envoie les edits de chaque
// map en parallèle (Promise.all), et un read-modify-write concurrent sur
// edits-<version>.json ne gardait que le dernier écrit — les modifications
// des autres maps (maps similaires, copier/coller, plusieurs maps éditées à
// la main) disparaissaient à l'enregistrement.
const mapEditQueues = new Map<string, Promise<void>>();

export async function addMapEdit(
  versionId: string,
  mapAddress: number,
  payload: any
): Promise<MapEdit | null> {
  const previous = mapEditQueues.get(versionId) ?? Promise.resolve();
  let result: MapEdit | null = null;
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      result = await addMapEditUnlocked(versionId, mapAddress, payload);
    });
  mapEditQueues.set(versionId, run);
  try {
    await run;
  } finally {
    if (mapEditQueues.get(versionId) === run) mapEditQueues.delete(versionId);
  }
  return result;
}

/** REMPLACE tous les edits d'une version (un enregistrement = l'état complet). */
export async function replaceMapEdits(
  versionId: string,
  edits: { mapAddress: number; payload: any }[]
): Promise<MapEdit[] | null> {
  const previous = mapEditQueues.get(versionId) ?? Promise.resolve();
  let result: MapEdit[] | null = null;
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const found = await findVersion(versionId);
      if (!found) return;
      const list: MapEdit[] = edits.map((e) => ({
        id: newId(),
        version: versionId,
        map_address: e.mapAddress ?? -1,
        payload: e.payload ?? {},
        created: nowIso(),
      }));
      await writeTextFile(
        `${projectDir(found.fileId)}/edits-${versionId}.json`,
        JSON.stringify(list),
        BASE
      );
      result = list;
    });
  mapEditQueues.set(versionId, run);
  try {
    await run;
  } finally {
    if (mapEditQueues.get(versionId) === run) mapEditQueues.delete(versionId);
  }
  return result;
}

// ── Custom solutions ──────────────────────────────────────────────
// User-made solutions extracted from a file version (its byte diff vs the
// original), stored GLOBALLY so they can be applied to other projects. One
// JSON file at the app-data root, independent of any project.

export interface CustomSolutionPatch {
  address: number; // absolute address in the SOURCE file it was made from
  data: number[]; // new bytes to write
  /**
   * The bytes this patch replaced in the source original. Used to relocate the
   * solution in a target file of a different size/base (search + verify) and to
   * avoid writing over a region that does not match. Optional for solutions
   * saved before relocation existed.
   */
  original?: number[];
}

export interface CustomSolution {
  id: string;
  name: string;
  description?: string;
  /** ECU type of the file it was made from (informational — apply with care). */
  ecuType?: string;
  createdAt: string;
  patches: CustomSolutionPatch[];
  /** Total number of bytes the solution changes. */
  byteCount: number;
  /**
   * A window of source-original bytes (with its source address) around the
   * first patch. Applying searches the target for this signature to compute a
   * global offset, so a solution made from a partial dump can be applied to a
   * full dump of the same calibration.
   */
  signature?: { address: number; bytes: number[] };
}

const CUSTOM_SOLUTIONS_FILE = "custom-solutions.json";

export async function listCustomSolutions(): Promise<CustomSolution[]> {
  try {
    const raw = await readTextFile(CUSTOM_SOLUTIONS_FILE, BASE);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CustomSolution[]) : [];
  } catch {
    return [];
  }
}

async function writeCustomSolutions(list: CustomSolution[]): Promise<void> {
  await writeTextFile(CUSTOM_SOLUTIONS_FILE, JSON.stringify(list, null, 2), BASE);
}

/** Add a solution (or replace one with the same id). Returns the new list. */
export async function saveCustomSolution(sol: CustomSolution): Promise<CustomSolution[]> {
  const list = await listCustomSolutions();
  const idx = list.findIndex((s) => s.id === sol.id);
  if (idx >= 0) list[idx] = sol;
  else list.push(sol);
  await writeCustomSolutions(list);
  return list;
}

export async function deleteCustomSolution(id: string): Promise<CustomSolution[]> {
  const list = (await listCustomSolutions()).filter((s) => s.id !== id);
  await writeCustomSolutions(list);
  return list;
}

async function addMapEditUnlocked(
  versionId: string,
  mapAddress: number,
  payload: any
): Promise<MapEdit | null> {
  const found = await findVersion(versionId);
  if (!found) return null;
  const edits = await listMapEdits(versionId);
  const edit: MapEdit = {
    id: newId(),
    version: versionId,
    map_address: mapAddress,
    payload: payload ?? {},
    created: nowIso(),
  };
  edits.push(edit);
  await writeTextFile(
    `${projectDir(found.fileId)}/edits-${versionId}.json`,
    JSON.stringify(edits),
    BASE
  );
  return edit;
}
