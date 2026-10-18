import { stat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { types } from 'node:util';
import { PhargusConfigError, isConfigKey, validateConfigValue } from './config-schema.js';
import type { AgentConfig } from './config-schema.js';

const JSON_NAME = 'phargus.config.json';
const JS_NAME = 'phargus.config.js';

type ConfigFormat = 'json' | 'js';

async function exists(cwd: string, name: string): Promise<boolean> {
  try {
    await stat(path.join(cwd, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new PhargusConfigError(name, undefined, 'cannot be accessed', { cause: error });
  }
}

/** Read and parse (`json`) or load (`js`) one config file; `source` labels any failure. */
async function loadRaw(
  cwd: string,
  file: string,
  format: ConfigFormat,
  source: string,
): Promise<unknown> {
  if (format === 'json') {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      throw new PhargusConfigError(source, undefined, 'cannot be read', { cause: error });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new PhargusConfigError(source, undefined, 'not valid JSON', { cause: error });
    }
  }
  try {
    // createRequire behaves the same in the ESM and CJS builds, unlike import().
    const loaded: unknown = createRequire(path.join(cwd, 'noop.js'))(file);
    return types.isModuleNamespaceObject(loaded)
      ? (loaded as { default?: unknown }).default
      : loaded;
  } catch (error) {
    throw new PhargusConfigError(source, undefined, 'failed to load', { cause: error });
  }
}

/** Validate a loaded config value; a relative `output` resolves against `cwd`. */
function toConfig(source: string, raw: unknown, cwd: string): Partial<AgentConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PhargusConfigError(source, undefined, 'must export or contain a plain object');
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!isConfigKey(key)) {
      throw new PhargusConfigError(source, key, 'unknown key');
    }
    const value = (raw as Record<string, unknown>)[key];
    validateConfigValue(source, key, value);
    result[key] =
      key === 'output' && value !== 'stdout' && value !== 'none'
        ? path.resolve(cwd, value as string)
        : value;
  }
  return result;
}

/** Read phargus.config.json or phargus.config.js from `cwd` (no parent search). Absent -> {}. */
export async function readConfigFile(cwd: string): Promise<Partial<AgentConfig>> {
  const hasJson = await exists(cwd, JSON_NAME);
  const hasJs = await exists(cwd, JS_NAME);
  if (hasJson && hasJs) {
    throw new PhargusConfigError(
      `${JSON_NAME} and ${JS_NAME}`,
      undefined,
      'both exist; keep only one',
    );
  }
  if (!hasJson && !hasJs) {
    return {};
  }
  const name = hasJson ? JSON_NAME : JS_NAME;
  const raw = await loadRaw(cwd, path.join(cwd, name), hasJson ? 'json' : 'js', name);
  return toConfig(name, raw, cwd);
}

/**
 * Read the one config file named by `value` (the content of `variable`), resolved against `cwd`.
 * The working directory is never searched, and no failure falls back to it: an empty value, an
 * extension other than `.json` or `.js`, a missing or unreadable file, a non-file and an invalid
 * config all throw a `PhargusConfigError` that names `variable`.
 */
export async function readPinnedConfigFile(
  cwd: string,
  variable: string,
  value: string,
): Promise<Partial<AgentConfig>> {
  if (value === '') {
    throw new PhargusConfigError(
      variable,
      undefined,
      'is set but empty; unset it to use the working directory lookup',
    );
  }
  const file = path.resolve(cwd, value);
  const source = `${variable} (${file})`;
  const extension = path.extname(file);
  if (extension !== '.json' && extension !== '.js') {
    throw new PhargusConfigError(
      source,
      undefined,
      `unsupported extension ${JSON.stringify(extension)}; use .json or .js`,
    );
  }
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PhargusConfigError(source, undefined, 'file does not exist', { cause: error });
    }
    throw new PhargusConfigError(source, undefined, 'cannot be accessed', { cause: error });
  }
  if (!info.isFile()) {
    throw new PhargusConfigError(source, undefined, 'not a regular file');
  }
  const raw = await loadRaw(cwd, file, extension === '.json' ? 'json' : 'js', source);
  return toConfig(source, raw, cwd);
}
