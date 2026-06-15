import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function resolveFromRoot(...parts) {
  return path.join(appRoot, ...parts);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function defaultDataDir() {
  return process.env.TECH_RADAR_DATA_DIR || resolveFromRoot('.data');
}
