import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { callerDirectory } from '../shared/module-directory.js';

/**
 * Locates the sandbox child entry: the compiled `.js` in the built trees, else the `.ts`
 * source (run under Node's type stripping). Returns an Error naming what was searched.
 */
export function resolveChildScript(): string | Error {
  const directory = callerDirectory();
  if (directory === undefined) {
    return new Error(
      'could not determine the directory of @pharn-dev/phargus/plugin-runner to find the sandbox child',
    );
  }
  const compiled = join(directory, 'workers', 'sandbox-child.js');
  if (existsSync(compiled)) {
    return compiled;
  }
  const source = join(directory, 'workers', 'sandbox-child.ts');
  if (existsSync(source)) {
    return source;
  }
  return new Error(`sandbox child script not found (looked for ${compiled} and ${source})`);
}
