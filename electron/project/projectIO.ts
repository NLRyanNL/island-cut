// Project files: JSON with media paths stored relative to the project file.
import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../../shared/types';

function toRel(projectFile: string, abs: string): string {
  if (!abs) return abs;
  const dir = path.dirname(projectFile);
  // keep absolute if on another drive (Windows) — path.relative would return an absolute path anyway
  const rel = path.relative(dir, abs);
  if (path.isAbsolute(rel)) return abs.replace(/\\/g, '/');
  return rel.replace(/\\/g, '/');
}

function toAbs(projectFile: string, p: string): string {
  if (!p) return p;
  const norm = p.replace(/[\\/]/g, path.sep);
  if (path.isAbsolute(norm) || /^[a-zA-Z]:[\\/]/.test(p)) return norm;
  return path.resolve(path.dirname(projectFile), norm);
}

export function serializeProject(project: Project, projectFile: string): string {
  const p: Project = structuredClone(project);
  p.modifiedAt = new Date().toISOString();
  for (const m of Object.values(p.media)) {
    m.path = toRel(projectFile, m.path);
    delete m.missing;
  }
  for (const c of Object.values(p.clips)) if (c.color?.lutPath) c.color.lutPath = toRel(projectFile, c.color.lutPath);
  for (const f of p.fonts) f.path = toRel(projectFile, f.path);
  return JSON.stringify(p, null, 1);
}

/** Write atomically: temp file + rename, so a crash never leaves a half-written project. */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows: rename over an existing file can fail if it is open elsewhere
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }
}

export function saveProject(project: Project, projectFile: string): void {
  writeFileAtomic(projectFile, serializeProject(project, projectFile));
}

export function loadProject(projectFile: string): Project {
  let raw: string;
  try {
    raw = fs.readFileSync(projectFile, 'utf8');
  } catch {
    throw new Error(`Could not open ${projectFile}`);
  }
  let p: Project;
  try {
    p = JSON.parse(raw);
  } catch {
    throw new Error('This project file is damaged (invalid JSON). Try the autosave copy.');
  }
  if (p.format !== 'uefn-trailer-project') throw new Error('This is not an IslandCut project file.');
  return resolveProject(p, projectFile);
}

export function resolveProject(p: Project, projectFile: string): Project {
  for (const m of Object.values(p.media)) {
    m.path = toAbs(projectFile, m.path);
    m.missing = !fs.existsSync(m.path);
  }
  for (const c of Object.values(p.clips)) if (c.color?.lutPath) c.color.lutPath = toAbs(projectFile, c.color.lutPath);
  for (const f of p.fonts ?? []) f.path = toAbs(projectFile, f.path);
  p.fonts = p.fonts ?? [];
  p.markers = p.markers ?? [];
  return p;
}

/**
 * Relink: given one located file for a missing media item, try to find other missing
 * files in the same folder by file name.
 */
export function findInFolder(folder: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return out;
  }
  const lower = new Map(entries.map((e) => [e.toLowerCase(), e]));
  for (const n of names) {
    const hit = lower.get(n.toLowerCase());
    if (hit) out[n] = path.join(folder, hit);
  }
  return out;
}
