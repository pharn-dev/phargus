import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { callerDirectory } from '../shared/module-directory.js';

/** Absolute path of a worker file bundled with the analyzer (`.js` in builds, `.ts` in source). */
export function resolveBundledWorkerFile(baseName: string): string {
  const dir = callerDirectory();
  if (dir === undefined) {
    throw new Error('analyzer could not locate its worker directory');
  }
  const candidates = [
    join(dir, 'workers', `${baseName}.js`),
    join(dir, 'workers', `${baseName}.ts`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`analyzer worker file not found; tried: ${candidates.join(', ')}`);
}
