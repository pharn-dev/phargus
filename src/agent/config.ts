import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Resolved agent configuration. `output` is 'stdout', 'none' (disabled) or an absolute file path. */
export type AgentConfig = Readonly<{
  intervalMs: number;
  output: string;
  /** Size bound of a file `output` in bytes; at the bound it moves to `<file>.1`. 0 = no bound. */
  outputMaxBytes: number;
  queueBound: number;
  enabled: boolean;
  /** Spans kept per sampling interval; 0 switches HTTP tracing off. */
  spanBuffer: number;
}>;

export type AgentConfigKey = keyof AgentConfig;

export const defaultAgentConfig: AgentConfig = Object.freeze({
  intervalMs: 1000,
  output: 'stdout',
  outputMaxBytes: 67_108_864,
  queueBound: 1024,
  enabled: true,
  spanBuffer: 1024,
});

export type LoadAgentConfigOptions = {
  /**
   * Receives each non-fatal config problem (an unknown PHARGUS_* variable, which is ignored, or a
   * phargus.config.js, which is not read). Defaults to one `[phargus] warning: ...` line on stderr.
   */
  onWarning?: (message: string) => void;
};

/** A config problem that names its source (file or variable) and, when known, the key. */
export class PhargusConfigError extends Error {
  readonly source: string;
  readonly key: string | undefined;

  constructor(source: string, key: string | undefined, reason: string, options?: ErrorOptions) {
    super(`phargus config: ${source}${key === undefined ? '' : `: ${key}`}: ${reason}`, options);
    this.name = 'PhargusConfigError';
    this.source = source;
    this.key = key;
  }
}

const JSON_NAME = 'phargus.config.json';
const JS_NAME = 'phargus.config.js';

/** The variable that pins the one config file to load instead of the working-directory lookup. */
const CONFIG_FILE_VARIABLE = 'PHARGUS_CONFIG';

const VARIABLES: Readonly<Record<string, AgentConfigKey>> = {
  PHARGUS_INTERVAL_MS: 'intervalMs',
  PHARGUS_OUTPUT: 'output',
  PHARGUS_OUTPUT_MAX_BYTES: 'outputMaxBytes',
  PHARGUS_QUEUE_BOUND: 'queueBound',
  PHARGUS_ENABLED: 'enabled',
  PHARGUS_SPAN_BUFFER: 'spanBuffer',
};

const VALID_VARIABLES = [...Object.keys(VARIABLES), CONFIG_FILE_VARIABLE].join(', ');

/**
 * `PHARGUS_*` names that belong to the `phargus serve` CLI, not the agent. A shell or container
 * that runs both sides of the pipe shares one environment, so the agent ignores these silently
 * instead of warning about them. Kept here as plain names: the agent imports nothing from the CLI.
 */
const CLI_VARIABLES: ReadonlySet<string> = new Set(['PHARGUS_TOKEN', 'PHARGUS_DEBUG']);

/** The inclusive range of each integer key; the other keys are `enabled` and `output`. */
const INTEGER_RANGES: Partial<Record<AgentConfigKey, readonly [number, number]>> = {
  intervalMs: [1, 3_600_000],
  queueBound: [1, 1_000_000],
  outputMaxBytes: [0, Number.MAX_SAFE_INTEGER],
  spanBuffer: [0, 65_536],
};

function describe(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return typeof value;
}

/** Validate one already-typed value for a known key. Throws PhargusConfigError. */
export function validateConfigValue(source: string, key: AgentConfigKey, value: unknown): void {
  const range = INTEGER_RANGES[key];
  if (range !== undefined) {
    const [min, max] = range;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new PhargusConfigError(
        source,
        key,
        `expected an integer from ${String(min)} to ${String(max)}, got ${describe(value)}`,
      );
    }
  } else if (
    key === 'enabled' ? typeof value !== 'boolean' : typeof value !== 'string' || value === ''
  ) {
    const expected = key === 'enabled' ? 'a boolean' : 'a non-empty string';
    throw new PhargusConfigError(source, key, `expected ${expected}, got ${describe(value)}`);
  }
}

/** Validate `value` for `key`; a file `output` resolves against `cwd`. */
function checked(source: string, key: AgentConfigKey, value: unknown, cwd: string): unknown {
  validateConfigValue(source, key, value);
  return key === 'output' && value !== 'stdout' && value !== 'none'
    ? path.resolve(cwd, value as string)
    : value;
}

function parseVariable(name: string, key: AgentConfigKey, text: string): unknown {
  if (INTEGER_RANGES[key] !== undefined) {
    if (!/^[0-9]+$/.test(text)) {
      throw new PhargusConfigError(
        name,
        key,
        `expected a non-negative integer, got ${JSON.stringify(text)}`,
      );
    }
    return Number(text);
  }
  if (key === 'enabled' && !['true', '1', 'false', '0'].includes(text)) {
    const reason = `expected true, false, 1 or 0, got ${JSON.stringify(text)}`;
    throw new PhargusConfigError(name, key, reason);
  }
  return key === 'enabled' ? text === 'true' || text === '1' : text;
}

/**
 * Map PHARGUS_* variables to config keys. Other variables, the CLI's own `PHARGUS_TOKEN` and
 * `PHARGUS_DEBUG`, and the config-file pin `PHARGUS_CONFIG`, are ignored. An unknown PHARGUS_ name
 * is reported once through `warn`, with the valid names, and ignored; an invalid value throws.
 */
export function readConfigEnv(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  warn: (message: string) => void,
): Partial<AgentConfig> {
  const result: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(env)) {
    if (
      !name.startsWith('PHARGUS_') ||
      text === undefined ||
      CLI_VARIABLES.has(name) ||
      name === CONFIG_FILE_VARIABLE
    ) {
      continue;
    }
    const key = Object.hasOwn(VARIABLES, name) ? VARIABLES[name] : undefined;
    if (key === undefined) {
      warn(`ignoring unknown environment variable ${name}; valid names: ${VALID_VARIABLES}`);
      continue;
    }
    result[key] = checked(name, key, parseVariable(name, key, text), cwd);
  }
  return result;
}

/**
 * Read, parse and validate the config file: the `.json` file `pinned` (PHARGUS_CONFIG) names,
 * resolved against `cwd`, or else phargus.config.json in `cwd` (no parent search; absent -> {}).
 * A pin never falls back to `cwd`: an empty value, another extension, a missing file and a
 * non-file all throw. A phargus.config.js in `cwd` is never read, only warned about.
 */
async function readConfigFile(
  cwd: string,
  pinned: string | undefined,
  warn: (message: string) => void,
): Promise<Partial<AgentConfig>> {
  if (pinned === '') {
    throw new PhargusConfigError(
      CONFIG_FILE_VARIABLE,
      undefined,
      'is set but empty; unset it to use the working directory lookup',
    );
  }
  if (pinned === undefined && (await stat(path.join(cwd, JS_NAME)).catch(() => false))) {
    warn(`${JS_NAME} is no longer read; move its settings to ${JSON_NAME}`);
  }
  const file = path.resolve(cwd, pinned ?? JSON_NAME);
  const source = pinned === undefined ? JSON_NAME : `${CONFIG_FILE_VARIABLE} (${file})`;
  const extension = path.extname(file);
  if (extension !== '.json') {
    throw new PhargusConfigError(
      source,
      undefined,
      `unsupported extension ${JSON.stringify(extension)}; use .json`,
    );
  }
  const info = await stat(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new PhargusConfigError(source, undefined, 'cannot be accessed', { cause: error });
  });
  if (info === undefined) {
    if (pinned === undefined) {
      return {};
    }
    throw new PhargusConfigError(source, undefined, 'file does not exist');
  }
  if (!info.isFile()) {
    throw new PhargusConfigError(source, undefined, 'not a regular file');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'not valid JSON' : 'cannot be read';
    throw new PhargusConfigError(source, undefined, reason, { cause: error });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PhargusConfigError(source, undefined, 'must contain a plain object');
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(defaultAgentConfig, key)) {
      throw new PhargusConfigError(source, key, 'unknown key');
    }
    result[key] = checked(source, key as AgentConfigKey, value, cwd);
  }
  return result;
}

function warnOnStderr(message: string): void {
  try {
    process.stderr.write(`[phargus] warning: ${message.replace(/\s+/g, ' ').trim()}\n`);
  } catch {
    // A warning must never throw into the caller; stderr is the only channel.
  }
}

/**
 * Resolve the agent config: defaults, then the config file, then PHARGUS_* env. The file is the one
 * `PHARGUS_CONFIG` names when that variable is set (the working directory is then not searched),
 * otherwise phargus.config.json in `cwd`.
 */
export async function loadAgentConfig(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  options: LoadAgentConfigOptions = {},
): Promise<AgentConfig> {
  const warn = options.onWarning ?? warnOnStderr;
  const fromEnv = readConfigEnv(env, cwd, warn);
  const fromFile = await readConfigFile(cwd, env[CONFIG_FILE_VARIABLE], warn);
  return Object.freeze({ ...defaultAgentConfig, ...fromFile, ...fromEnv });
}
