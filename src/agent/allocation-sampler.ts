/// <reference types="node" />
import { Session } from 'node:inspector/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/** One allocation site: where bytes were allocated, summed over the sampled profile. */
export type AllocationSite = {
  functionName: string;
  url: string;
  /** 1-based line number (as in stack traces and editors); `0` when V8 reports no line. */
  line: number;
  /** Sampled bytes still live at the end of sampling, as an integer greater than zero. */
  bytes: number;
};

/** Structural view of a V8 sampling heap profile node (no `node:inspector` import needed). */
export type AllocationProfileNode = {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: readonly AllocationProfileNode[];
};

/**
 * Collapse a V8 sampling heap profile tree into allocation sites, largest first.
 * Nodes are keyed by function name, url and line; their `selfSize` values are summed
 * with integer math. Ties are ordered by url, line, then function name. Returns at
 * most `limit` sites.
 */
export function aggregateAllocationProfile(
  head: AllocationProfileNode,
  limit: number,
): AllocationSite[] {
  const sites = new Map<string, AllocationSite>();
  const stack: AllocationProfileNode[] = [head];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const size = Math.trunc(node.selfSize);
    if (size > 0) {
      const { functionName, url, lineNumber } = node.callFrame;
      const line = lineNumber >= 0 ? Math.trunc(lineNumber) + 1 : 0;
      const key = `${functionName}\u0000${url}\u0000${line}`;
      const existing = sites.get(key);
      if (existing === undefined) {
        sites.set(key, { functionName, url, line, bytes: Math.min(size, Number.MAX_SAFE_INTEGER) });
      } else {
        existing.bytes = Math.min(existing.bytes + size, Number.MAX_SAFE_INTEGER);
      }
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return [...sites.values()]
    .sort(
      (a, b) =>
        b.bytes - a.bytes ||
        compareStrings(a.url, b.url) ||
        a.line - b.line ||
        compareStrings(a.functionName, b.functionName),
    )
    .slice(0, limit);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export type AllocationSamplingOptions = {
  /** Average bytes between sampled allocations (V8 `samplingInterval`). */
  samplingInterval?: number;
  /** How long to sample, in milliseconds. */
  durationMs?: number;
  /** Maximum number of sites to return. */
  limit?: number;
};

/** V8's own default sampling interval, in bytes. */
export const DEFAULT_ALLOCATION_SAMPLING_INTERVAL = 32768;
export const DEFAULT_ALLOCATION_SAMPLING_DURATION_MS = 1000;
export const DEFAULT_ALLOCATION_SITE_LIMIT = 20;

/** Largest delay `setTimeout` honours; beyond it Node fires after 1 ms. */
const MAX_DURATION_MS = 2147483647;

let inProgress = false;

function positiveInteger(
  options: AllocationSamplingOptions,
  name: keyof AllocationSamplingOptions,
  fallback: number,
): number {
  const value: unknown = options[name];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`phargus: sampleAllocations option ${name} must be a positive integer`);
  }
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sample allocations on the main isolate for `durationMs` using V8's sampling heap
 * profiler and return the top allocation sites, largest first. Only allocations still
 * live when sampling stops are reported. `line` is 1-based. Never throws synchronously:
 * every failure is a rejection. Only one sampling session may run at a time.
 */
export async function sampleAllocations(
  options: AllocationSamplingOptions = {},
): Promise<AllocationSite[]> {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('phargus: sampleAllocations options must be an object');
  }
  const samplingInterval = positiveInteger(
    options,
    'samplingInterval',
    DEFAULT_ALLOCATION_SAMPLING_INTERVAL,
  );
  const durationMs = positiveInteger(
    options,
    'durationMs',
    DEFAULT_ALLOCATION_SAMPLING_DURATION_MS,
  );
  if (durationMs > MAX_DURATION_MS) {
    throw new TypeError(
      `phargus: sampleAllocations option durationMs must not exceed ${MAX_DURATION_MS}`,
    );
  }
  const limit = positiveInteger(options, 'limit', DEFAULT_ALLOCATION_SITE_LIMIT);

  if (inProgress) {
    throw new Error('phargus: an allocation sampling session is already in progress');
  }
  inProgress = true;
  try {
    const session = new Session();
    let connected = false;
    let enabled = false;
    let started = false;
    let stopped = false;
    let sites: AllocationSite[] = [];
    let failure: { error: unknown } | undefined;

    try {
      session.connect();
      connected = true;
      await session.post('HeapProfiler.enable');
      enabled = true;
      await session.post('HeapProfiler.startSampling', { samplingInterval });
      started = true;
      await sleep(durationMs);
      const { profile } = await session.post('HeapProfiler.stopSampling');
      stopped = true;
      sites = aggregateAllocationProfile(profile.head, limit);
    } catch (error) {
      failure = { error };
    }

    const cleanupErrors: string[] = [];
    let cleanupCause: unknown;
    const recordCleanup = (error: unknown): void => {
      cleanupErrors.push(describe(error));
      cleanupCause ??= error;
    };
    if (started && !stopped) {
      try {
        await session.post('HeapProfiler.stopSampling');
      } catch (error) {
        recordCleanup(error);
      }
    }
    if (enabled) {
      try {
        await session.post('HeapProfiler.disable');
      } catch (error) {
        recordCleanup(error);
      }
    }
    if (connected) {
      try {
        session.disconnect();
      } catch (error) {
        recordCleanup(error);
      }
    }

    const suffix =
      cleanupErrors.length > 0 ? `; cleanup also failed: ${cleanupErrors.join('; ')}` : '';
    if (failure !== undefined) {
      throw new Error(`phargus: allocation sampling failed: ${describe(failure.error)}${suffix}`, {
        cause: failure.error,
      });
    }
    if (cleanupErrors.length > 0) {
      throw new Error(`phargus: allocation sampling cleanup failed: ${cleanupErrors.join('; ')}`, {
        cause: cleanupCause,
      });
    }
    return sites;
  } finally {
    inProgress = false;
  }
}
