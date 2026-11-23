import type { AgentSample, BackpressureHotspot } from '../agent/index.js';
import { truncToNonNegativeInt } from '../agent/int.js';

/** Hotspots a closed window keeps: the top ones by `totalStall`. */
export const MAX_WINDOW_HOTSPOTS = 5;

/** Longest hotspot `site` a window keeps, in UTF-16 code units; longer sites are cut. */
export const MAX_HOTSPOT_SITE_LENGTH = 256;

/**
 * Distinct sites one open window tracks. A hotspot for a new site arriving once the map is full is
 * left out of the window's hotspots (its stalls still count in `events` and `totalStall`), so a
 * window's memory stays bounded whatever the input holds.
 */
export const MAX_TRACKED_SITES = 64;

type SiteStats = { events: number; totalStall: number; maxStall: number };

/** One closed aggregation window. Lag and stalls are nanoseconds, memory is bytes. All integers. */
export type AggregatedWindow = {
  start: number;
  end: number;
  count: number;
  late: number;
  eventLoop: { max: number; p99: number; mean: number };
  memory: { heapUsedLast: number; heapUsedMax: number; rssLast: number; rssMax: number };
  gc: { count: number; totalPause: number; maxPause: number };
  backpressure: {
    events: number;
    totalStall: number;
    maxStall: number;
    hotspots: BackpressureHotspot[];
  };
};

/** The open, mutable state of a window while samples are still being added. */
export type WindowAccumulator = {
  start: number;
  count: number;
  late: number;
  eventLoopMax: number;
  eventLoopP99Max: number;
  eventLoopMeanSum: number;
  heapUsedLast: number;
  heapUsedMax: number;
  rssLast: number;
  rssMax: number;
  gcCount: number;
  gcTotalPause: number;
  gcMaxPause: number;
  bpEvents: number;
  bpTotalStall: number;
  bpMaxStall: number;
  /** Hotspot stats by (cut) site, at most MAX_TRACKED_SITES entries. */
  bpSites: Map<string, SiteStats>;
};

function saturatingAdd(a: number, b: number): number {
  return a > Number.MAX_SAFE_INTEGER - b ? Number.MAX_SAFE_INTEGER : a + b;
}

export function windowStartOf(timestamp: number, windowMs: number): number {
  return Math.floor(timestamp / windowMs) * windowMs;
}

export function openWindow(start: number): WindowAccumulator {
  return {
    start,
    count: 0,
    late: 0,
    eventLoopMax: 0,
    eventLoopP99Max: 0,
    eventLoopMeanSum: 0,
    heapUsedLast: 0,
    heapUsedMax: 0,
    rssLast: 0,
    rssMax: 0,
    gcCount: 0,
    gcTotalPause: 0,
    gcMaxPause: 0,
    bpEvents: 0,
    bpTotalStall: 0,
    bpMaxStall: 0,
    bpSites: new Map(),
  };
}

/**
 * `site` cut to MAX_HOTSPOT_SITE_LENGTH. A cut is copied through a Buffer: V8 may keep a plain
 * `slice` as a view of the whole parsed string, which a long-lived window would then retain.
 */
function cutSite(site: string): string {
  if (site.length <= MAX_HOTSPOT_SITE_LENGTH) {
    return site;
  }
  return Buffer.from(site.slice(0, MAX_HOTSPOT_SITE_LENGTH), 'utf16le').toString('utf16le');
}

/** Merge a sample's hotspots by site. A value that is not an array, or a malformed entry, is skipped. */
function addHotspots(sites: Map<string, SiteStats>, hotspots: unknown): void {
  if (!Array.isArray(hotspots)) {
    return;
  }
  for (const entry of hotspots as unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const { site, events, totalStall, maxStall } = entry as Record<string, unknown>;
    if (
      typeof site !== 'string' ||
      typeof events !== 'number' ||
      typeof totalStall !== 'number' ||
      typeof maxStall !== 'number'
    ) {
      continue;
    }
    const key = cutSite(site);
    let stats = sites.get(key);
    if (stats === undefined) {
      if (sites.size >= MAX_TRACKED_SITES) {
        continue;
      }
      stats = { events: 0, totalStall: 0, maxStall: 0 };
      sites.set(key, stats);
    }
    stats.events = saturatingAdd(stats.events, truncToNonNegativeInt(events));
    stats.totalStall = saturatingAdd(stats.totalStall, truncToNonNegativeInt(totalStall));
    stats.maxStall = Math.max(stats.maxStall, truncToNonNegativeInt(maxStall));
  }
}

/** The top MAX_WINDOW_HOTSPOTS sites by totalStall, then events, then site. */
function topHotspots(sites: Map<string, SiteStats>): BackpressureHotspot[] {
  return [...sites.entries()]
    .map(([site, stats]) => ({ site, ...stats }))
    .sort(
      (a, b) =>
        b.totalStall - a.totalStall ||
        b.events - a.events ||
        (a.site < b.site ? -1 : a.site > b.site ? 1 : 0),
    )
    .slice(0, MAX_WINDOW_HOTSPOTS);
}

export function addSample(acc: WindowAccumulator, sample: AgentSample): void {
  const heapUsed = truncToNonNegativeInt(sample.memory.heapUsed);
  const rss = truncToNonNegativeInt(sample.memory.rss);
  acc.count = saturatingAdd(acc.count, 1);
  acc.eventLoopMax = Math.max(acc.eventLoopMax, truncToNonNegativeInt(sample.eventLoop.max));
  acc.eventLoopP99Max = Math.max(acc.eventLoopP99Max, truncToNonNegativeInt(sample.eventLoop.p99));
  acc.eventLoopMeanSum = saturatingAdd(
    acc.eventLoopMeanSum,
    truncToNonNegativeInt(sample.eventLoop.mean),
  );
  acc.heapUsedLast = heapUsed;
  acc.heapUsedMax = Math.max(acc.heapUsedMax, heapUsed);
  acc.rssLast = rss;
  acc.rssMax = Math.max(acc.rssMax, rss);
  acc.gcCount = saturatingAdd(acc.gcCount, truncToNonNegativeInt(sample.gc.count));
  acc.gcTotalPause = saturatingAdd(acc.gcTotalPause, truncToNonNegativeInt(sample.gc.totalPause));
  acc.gcMaxPause = Math.max(acc.gcMaxPause, truncToNonNegativeInt(sample.gc.maxPause));
  acc.bpEvents = saturatingAdd(acc.bpEvents, truncToNonNegativeInt(sample.backpressure.events));
  acc.bpTotalStall = saturatingAdd(
    acc.bpTotalStall,
    truncToNonNegativeInt(sample.backpressure.totalStall),
  );
  acc.bpMaxStall = Math.max(acc.bpMaxStall, truncToNonNegativeInt(sample.backpressure.maxStall));
  // Typed as the agent writes it, but the line is untrusted input: read it as unknown.
  const hotspots: unknown = sample.backpressure.hotspots;
  addHotspots(acc.bpSites, hotspots);
}

export function closeWindow(acc: WindowAccumulator, windowMs: number): AggregatedWindow {
  return {
    start: acc.start,
    end: acc.start + windowMs,
    count: acc.count,
    late: acc.late,
    eventLoop: {
      max: acc.eventLoopMax,
      p99: acc.eventLoopP99Max,
      mean: acc.count === 0 ? 0 : Math.floor(acc.eventLoopMeanSum / acc.count),
    },
    memory: {
      heapUsedLast: acc.heapUsedLast,
      heapUsedMax: acc.heapUsedMax,
      rssLast: acc.rssLast,
      rssMax: acc.rssMax,
    },
    gc: { count: acc.gcCount, totalPause: acc.gcTotalPause, maxPause: acc.gcMaxPause },
    backpressure: {
      events: acc.bpEvents,
      totalStall: acc.bpTotalStall,
      maxStall: acc.bpMaxStall,
      hotspots: topHotspots(acc.bpSites),
    },
  };
}
