import type { BackpressureHotspot } from '../agent/index.js';
import { MAX_HOTSPOT_SITE_LENGTH, MAX_WINDOW_HOTSPOTS, type AggregatedWindow } from './window.js';

/** One window as one NDJSON line, newline included. */
export function serializeWindow(window: AggregatedWindow): string {
  return `${JSON.stringify(window)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * A persisted window's hotspots: an empty list when the field is absent (a line written before
 * windows kept them), undefined when it is present but not a list of at most MAX_WINDOW_HOTSPOTS
 * entries, each a site of at most MAX_HOTSPOT_SITE_LENGTH characters and three safe integers.
 */
function hotspotsOf(value: unknown): BackpressureHotspot[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_WINDOW_HOTSPOTS) {
    return undefined;
  }
  const hotspots: BackpressureHotspot[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const { site } = entry;
    const events = int(entry.events);
    const totalStall = int(entry.totalStall);
    const maxStall = int(entry.maxStall);
    if (
      typeof site !== 'string' ||
      site.length > MAX_HOTSPOT_SITE_LENGTH ||
      events === undefined ||
      totalStall === undefined ||
      maxStall === undefined
    ) {
      return undefined;
    }
    hotspots.push({ site, events, totalStall, maxStall });
  }
  return hotspots;
}

/**
 * Parse one line back into a window. Returns undefined for anything that is not valid JSON or
 * that lacks a safe integer in any field; the result holds exactly the known fields.
 */
export function parseWindowLine(line: string): AggregatedWindow | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  const { eventLoop, memory, gc, backpressure } = raw;
  if (!isRecord(eventLoop) || !isRecord(memory) || !isRecord(gc) || !isRecord(backpressure)) {
    return undefined;
  }
  const start = int(raw.start);
  const end = int(raw.end);
  const count = int(raw.count);
  const late = int(raw.late);
  const elMax = int(eventLoop.max);
  const elP99 = int(eventLoop.p99);
  const elMean = int(eventLoop.mean);
  const heapLast = int(memory.heapUsedLast);
  const heapMax = int(memory.heapUsedMax);
  const rssLast = int(memory.rssLast);
  const rssMax = int(memory.rssMax);
  const gcCount = int(gc.count);
  const gcTotal = int(gc.totalPause);
  const gcMax = int(gc.maxPause);
  const bpEvents = int(backpressure.events);
  const bpTotal = int(backpressure.totalStall);
  const bpMax = int(backpressure.maxStall);
  const bpHotspots = hotspotsOf(backpressure.hotspots);
  if (
    start === undefined ||
    end === undefined ||
    count === undefined ||
    late === undefined ||
    elMax === undefined ||
    elP99 === undefined ||
    elMean === undefined ||
    heapLast === undefined ||
    heapMax === undefined ||
    rssLast === undefined ||
    rssMax === undefined ||
    gcCount === undefined ||
    gcTotal === undefined ||
    gcMax === undefined ||
    bpEvents === undefined ||
    bpTotal === undefined ||
    bpMax === undefined ||
    bpHotspots === undefined
  ) {
    return undefined;
  }
  return {
    start,
    end,
    count,
    late,
    eventLoop: { max: elMax, p99: elP99, mean: elMean },
    memory: { heapUsedLast: heapLast, heapUsedMax: heapMax, rssLast, rssMax },
    gc: { count: gcCount, totalPause: gcTotal, maxPause: gcMax },
    backpressure: {
      events: bpEvents,
      totalStall: bpTotal,
      maxStall: bpMax,
      hotspots: bpHotspots,
    },
  };
}
