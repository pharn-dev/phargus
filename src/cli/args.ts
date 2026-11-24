import { parseArgs } from 'node:util';
import { DEFAULT_MAX_LINE_BYTES, type AlertMetric, type AlertRule } from '../collector/index.js';
import { isLoopbackHost } from '../dashboard/index.js';

/** A bad command line: reported as `phargus: <message>` and exit code 2, never with a stack. */
export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type ServeInput = { kind: 'stdin' } | { kind: 'file'; path: string };

export type ServeOptions = {
  port: number;
  host: string;
  token: string | undefined;
  /** Extra `Host` names the dashboard answers, passed to `createDashboardServer`'s `allowedHosts`. */
  allowedHosts: readonly string[];
  windowMs: number;
  maxLineBytes: number;
  input: ServeInput;
  /** Write the app's own lines to stdout: on for stdin unless `--no-passthrough`, off for a file. */
  passthrough: boolean;
  /** Collector alert rules from `--alert`, in flag order; empty without the flag. */
  alerts: readonly AlertRule[];
};

export type ParsedArgs =
  { kind: 'help' } | { kind: 'version' } | { kind: 'serve'; options: ServeOptions };

export const DEFAULT_PORT = 7070;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_WINDOW_MS = 1000;

const DIGITS = /^[0-9]+$/;
const PORT_DIGITS = /^[0-9]{1,5}$/;
/** Characters that cannot appear in a `host` or `host:port` (a scheme, path, query or user part). */
const NOT_A_HOST = /[\s/?#@\\]/;

function parsePort(value: string): number {
  const port = PORT_DIGITS.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new UsageError(`--port must be an integer from 0 to 65535, got "${value}"`);
  }
  return port;
}

function parseAllowedHost(value: string): string {
  if (value.length === 0 || NOT_A_HOST.test(value)) {
    throw new UsageError(
      `--allowed-host must be a host name or host:port without a scheme or path, got "${value}"`,
    );
  }
  return value;
}

/** True when an `--allowed-host` value (`name`, `name:port`, `[v6]:port` or a bare v6) is loopback. */
function allowedHostIsLoopback(entry: string): boolean {
  const value = entry.toLowerCase();
  const bracketed = /^(\[[^\]]*\])(?::[0-9]+)?$/.exec(value);
  if (bracketed?.[1] !== undefined) {
    return isLoopbackHost(bracketed[1]);
  }
  const named = /^([^:]*):[0-9]+$/.exec(value);
  return isLoopbackHost(named?.[1] ?? value);
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = DIGITS.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

type MetricUnit = 'nanoseconds' | 'bytes' | 'count';

/** Every alertable metric and the unit of its values; a new collector metric must be added here. */
const METRIC_UNITS: Record<AlertMetric, MetricUnit> = {
  'eventLoop.max': 'nanoseconds',
  'eventLoop.p99': 'nanoseconds',
  'eventLoop.mean': 'nanoseconds',
  'memory.heapUsedLast': 'bytes',
  'memory.heapUsedMax': 'bytes',
  'memory.rssLast': 'bytes',
  'memory.rssMax': 'bytes',
  'gc.count': 'count',
  'gc.totalPause': 'nanoseconds',
  'gc.maxPause': 'nanoseconds',
  'backpressure.events': 'count',
  'backpressure.totalStall': 'nanoseconds',
  'backpressure.maxStall': 'nanoseconds',
};

/** Threshold units, each with the metric unit it belongs to and its size in that unit. */
const UNITS: Record<string, { of: MetricUnit; times: bigint }> = {
  ms: { of: 'nanoseconds', times: 1_000_000n },
  s: { of: 'nanoseconds', times: 1_000_000_000n },
  MiB: { of: 'bytes', times: 1_048_576n },
  GiB: { of: 'bytes', times: 1_073_741_824n },
};

const METRIC = /^[A-Za-z0-9_.]*/;
const THRESHOLD = /^([0-9]+)([A-Za-z]*)(?::([0-9]+))?$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Parses one `--alert '<metric><op><threshold>[:<windows>]'` value; the rule id is the value. */
function parseAlertFlag(value: string): AlertRule {
  const fail = (problem: string): never => {
    throw new UsageError(`--alert "${value}": ${problem}`);
  };
  const name = METRIC.exec(value)?.[0] ?? '';
  if (!Object.hasOwn(METRIC_UNITS, name)) {
    fail(`unknown metric "${name}"; expected one of ${Object.keys(METRIC_UNITS).join(', ')}`);
  }
  const metric = name as AlertMetric;
  const rest = value.slice(name.length);
  const comparison = rest.startsWith('>=') ? '>=' : rest.startsWith('>') ? '>' : undefined;
  if (comparison === undefined) {
    return fail('the operator after the metric must be > or >=');
  }
  const parts = THRESHOLD.exec(rest.slice(comparison.length));
  if (parts?.[1] === undefined) {
    return fail(
      'the threshold must be a non-negative integer with an optional unit (ms, s, MiB, GiB), then an optional :<windows>',
    );
  }
  const [, digits, unitName = '', windows] = parts;
  let threshold = BigInt(digits);
  if (unitName !== '') {
    const unit = UNITS[unitName];
    if (unit === undefined) {
      return fail(`unknown unit "${unitName}"; expected ms, s, MiB or GiB`);
    }
    const metricUnit = METRIC_UNITS[metric];
    if (unit.of !== metricUnit) {
      const fits =
        metricUnit === 'nanoseconds'
          ? 'ms or s'
          : metricUnit === 'bytes'
            ? 'MiB or GiB'
            : 'no unit';
      return fail(
        `unit "${unitName}" does not fit ${metric}, which counts ${metricUnit}; use ${fits}`,
      );
    }
    threshold *= unit.times;
  }
  if (threshold > MAX_SAFE) {
    fail(`the threshold is larger than ${String(Number.MAX_SAFE_INTEGER)}`);
  }
  const forWindows = windows === undefined ? 1n : BigInt(windows);
  if (forWindows < 1n || forWindows > MAX_SAFE) {
    fail(`the window count must be an integer from 1 to ${String(Number.MAX_SAFE_INTEGER)}`);
  }
  return {
    id: value,
    metric,
    comparison,
    threshold: Number(threshold),
    forWindows: Number(forWindows),
  };
}

/**
 * Parses `argv` (without the node and script entries). `--help` and `--version` win over
 * everything else. The token comes from `--token`, else a non-empty `PHARGUS_TOKEN`; a host or an
 * `--allowed-host` that is not loopback without a token is refused here, before anything binds.
 */
export function parseServeArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        port: { type: 'string' },
        host: { type: 'string' },
        token: { type: 'string' },
        'allowed-host': { type: 'string', multiple: true },
        'window-ms': { type: 'string' },
        'max-line-bytes': { type: 'string' },
        'no-passthrough': { type: 'boolean' },
        alert: { type: 'string', multiple: true },
      },
    });
  } catch (error) {
    if (error instanceof TypeError) {
      // --help and --version still win over a bad flag (`--bogus --help` prints the usage).
      const loose = parseArgs({ args: [...argv], allowPositionals: true, strict: false });
      if (loose.values['help'] === true || loose.values['h'] === true) {
        return { kind: 'help' };
      }
      if (loose.values['version'] === true || loose.values['v'] === true) {
        return { kind: 'version' };
      }
      // Strict parseArgs reports unknown flags and missing values by name (`Unknown option '--bogus'`).
      throw new UsageError(error.message);
    }
    throw error;
  }

  const { values, positionals } = parsed;
  if (values.help === true) {
    return { kind: 'help' };
  }
  if (values.version === true) {
    return { kind: 'version' };
  }

  const [command, ...rest] = positionals;
  if (command === undefined) {
    throw new UsageError("no command given; expected 'serve'");
  }
  if (command !== 'serve') {
    throw new UsageError(`unknown command "${command}"; expected 'serve'`);
  }
  if (rest.length > 1) {
    throw new UsageError(
      `serve takes at most one input (a file path or "-" for stdin), got ${String(rest.length)}`,
    );
  }

  const port = values.port === undefined ? DEFAULT_PORT : parsePort(values.port);
  const windowMs =
    values['window-ms'] === undefined
      ? DEFAULT_WINDOW_MS
      : parsePositiveInteger('--window-ms', values['window-ms']);
  const maxLineBytes =
    values['max-line-bytes'] === undefined
      ? undefined
      : parsePositiveInteger('--max-line-bytes', values['max-line-bytes']);

  const host = values.host ?? DEFAULT_HOST;
  if (host.length === 0) {
    throw new UsageError('--host must not be empty');
  }
  if (values.token !== undefined && values.token.length === 0) {
    throw new UsageError('--token must not be empty');
  }
  const envToken = env['PHARGUS_TOKEN'];
  const token = values.token ?? (envToken === undefined || envToken === '' ? undefined : envToken);
  const allowedHosts = (values['allowed-host'] ?? []).map(parseAllowedHost);
  // One rule: a --host or --allowed-host that is not loopback needs a token of 16+ characters.
  const bindExposed = !isLoopbackHost(host);
  const exposedName = bindExposed
    ? undefined
    : allowedHosts.find((entry) => !allowedHostIsLoopback(entry));
  if (bindExposed || exposedName !== undefined) {
    if (token === undefined) {
      const what =
        exposedName === undefined
          ? `to bind --host "${host}"`
          : `for --allowed-host "${exposedName}"`;
      throw new UsageError(
        `a token is required ${what} because it is not a loopback address; ` +
          'pass --token or set PHARGUS_TOKEN',
      );
    }
    if (token.length < 16) {
      const source = values.token === undefined ? 'PHARGUS_TOKEN' : '--token';
      throw new UsageError(`${source} must be at least 16 characters for a non-loopback host`);
    }
  }

  const alertValues = values.alert ?? [];
  const repeated = alertValues.find((value, index) => alertValues.indexOf(value) !== index);
  if (repeated !== undefined) {
    throw new UsageError(`--alert "${repeated}" is given more than once`);
  }
  const alerts = alertValues.map(parseAlertFlag);

  const [spec] = rest;
  const input: ServeInput =
    spec === undefined || spec === '-' ? { kind: 'stdin' } : { kind: 'file', path: spec };

  return {
    kind: 'serve',
    options: {
      port,
      host,
      token,
      allowedHosts,
      windowMs,
      maxLineBytes: maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      input,
      passthrough: input.kind === 'stdin' && values['no-passthrough'] !== true,
      alerts,
    },
  };
}
