// JSON state files shared between processes (listener, monitor, API, bot, cron scanners).
//
// Writes go to a temp file in the same directory and are renamed into place, so a reader in another
// process sees either the old file or the new one, never a truncated one. Reads distinguish "file
// does not exist" (a legitimate empty start) from "file exists but does not parse" (a partial or
// corrupt write): the second case must never be treated as empty, because the caller would then save
// an empty object over real data.

import * as fs from 'fs';
import * as path from 'path';

export class JsonReadError extends Error {
  constructor(public file: string, cause: string) {
    super(`Could not parse ${path.basename(file)}: ${cause}`);
  }
}

export function writeJsonAtomic(file: string, value: unknown, pretty = true): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// Returns `fallback` only when the file is absent. Throws JsonReadError when it exists but is unreadable.
export function readJsonStrict<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, 'utf-8');
  try {
    return JSON.parse(raw) as T;
  } catch (e: any) {
    throw new JsonReadError(file, e?.message || 'invalid JSON');
  }
}

// For read-only consumers that can tolerate missing data: returns `fallback` on absence or parse error.
export function readJsonLoose<T>(file: string, fallback: T): T {
  try {
    return readJsonStrict(file, fallback);
  } catch {
    return fallback;
  }
}
