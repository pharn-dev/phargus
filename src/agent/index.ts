// The public API of `@pharn-dev/phargus/agent`: the names docs/API.md documents, nothing else.
// Everything else in src/agent is internal and may change in any release.
export { currentTraceId, runWithTrace } from './context.js';
export { takeHeapSnapshot } from './heap-snapshot.js';
export type { HeapSnapshotOptions, HeapSnapshotResult } from './heap-snapshot.js';
export { sampleAllocations } from './allocation-sampler.js';
export type { AllocationSamplingOptions, AllocationSite } from './allocation-sampler.js';
export { sampleHeapSpaces } from './heap-space-sampler.js';
export type { HeapSpaceEntry, HeapSpaceSample } from './heap-space-sampler.js';
export { createDeoptParser, ANONYMOUS_FUNCTION, DEPENDENT_CODE_KIND } from './deopt-parser.js';
export type { DeoptEvent, DeoptLocation, DeoptParser, DeoptParserOptions } from './deopt-parser.js';
export { PhargusPermissionError } from './permission.js';

// The output format: one NDJSON line per sample or span.
export { SPAN_RECORD_TYPE } from './span-record.js';
export type { SpanRecord, AgentLossCounters, AgentSampleLine } from './span-record.js';
export type { TraceSpan } from './span-buffer.js';
export type { AgentSample } from './sampler-controller.js';
export type { EventLoopSample } from './event-loop-sampler.js';
export type { GcSample } from './gc-sampler.js';
export type { MemorySample } from './memory-sampler.js';
export type { BackpressureHotspot, BackpressureSample } from './backpressure-probe.js';
