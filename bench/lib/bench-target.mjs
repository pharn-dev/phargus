// Benchmark target: one HTTP server running one workload, under one agent variant. Forked by
// bench/overhead.mjs; measures itself between the parent's 'start' and 'stop' requests.
//
// Variants that preload the agent (`idle`, `full`, `notrace`, `pipe`) get
// `--import @pharn-dev/phargus/agent` from the parent. `tracing` and `samplers` load the agent's
// built internal files (no auto-start) here, from the directory of BENCH_AGENT_INDEX: the public
// entry does not export the exporter, the sampler controller or the HTTP tracing pieces.
import http from 'node:http';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { describe } from './common.mjs';
import { die, send, serve } from './ipc.mjs';
import { createHandler } from './workloads.mjs';

const SAMPLE_INTERVAL_MS = 1000;
const workload = process.env.BENCH_WORKLOAD ?? '';
const variant = process.env.BENCH_VARIANT ?? '';

/**
 * NDJSON to stdout through the agent's own exporter, as the auto-started agent would do. The
 * harness points stdout at a file and counts what was written after the cell.
 */
function stdoutExporter(createNdjsonExporter) {
  const exporter = createNdjsonExporter(process.stdout);
  exporter.done.then(undefined, (err) => die(new Error(`exporter failed: ${describe(err)}`)));
  return exporter;
}

async function setUpVariant() {
  if (variant !== 'tracing' && variant !== 'samplers') return;
  const indexUrl = process.env.BENCH_AGENT_INDEX;
  if (indexUrl === undefined) throw new Error('BENCH_AGENT_INDEX is not set');
  const internal = (file) => import(new URL(file, indexUrl).href);
  const { createNdjsonExporter } = await internal('./ndjson-exporter.js');
  const exporter = stdoutExporter(createNdjsonExporter);
  if (variant === 'tracing') {
    // HTTP tracing only: spans drained once per interval, like the auto-started agent does.
    const tracing = await internal('./http-tracing.js');
    tracing.enable();
    const flushSpans = () => {
      for (const span of tracing.drainSpans().spans) exporter.export({ type: 'span', ...span });
    };
    setInterval(flushSpans, SAMPLE_INTERVAL_MS).unref();
  } else {
    // Samplers and the backpressure probe only; HTTP tracing stays off.
    const { createSamplerController } = await internal('./sampler-controller.js');
    createSamplerController((sample) => exporter.export(sample)).start(SAMPLE_INTERVAL_MS);
  }
}

let handled = 0;
let errors = 0;
let firstError;
let gcCount = 0;
let gcPauseUs = 0;

new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcCount += 1;
    gcPauseUs += Math.round(entry.duration * 1000);
  }
}).observe({ entryTypes: ['gc'] });

const handler = createHandler(workload, (err) => {
  errors += 1;
  firstError ??= describe(err);
});

let baseline;

async function main() {
  await setUpVariant();
  const server = http.createServer({ keepAliveTimeout: 60_000 }, (req, res) => {
    handled += 1;
    handler(req, res);
  });
  server.on('clientError', (err, socket) => {
    errors += 1;
    firstError ??= `clientError: ${describe(err)}`;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  serve({
    start() {
      baseline = {
        handled,
        errors,
        gcCount,
        gcPauseUs,
        cpu: process.cpuUsage(),
        elu: performance.eventLoopUtilization(),
        at: process.hrtime.bigint(),
      };
      return { type: 'started' };
    },
    stop() {
      if (baseline === undefined) throw new Error('stop before start');
      const cpu = process.cpuUsage(baseline.cpu);
      return {
        type: 'stats',
        requests: handled - baseline.handled,
        wallUs: Math.round(Number(process.hrtime.bigint() - baseline.at) / 1000),
        cpuUserUs: cpu.user,
        cpuSystemUs: cpu.system,
        elu: performance.eventLoopUtilization(baseline.elu).utilization,
        rssBytes: process.memoryUsage.rss(),
        gcCount: gcCount - baseline.gcCount,
        gcPauseUs: gcPauseUs - baseline.gcPauseUs,
        errors: errors - baseline.errors,
        firstError,
      };
    },
    exit() {
      server.closeAllConnections();
      server.close();
      process.exit(0);
    },
  });
  await send({ type: 'ready', port: server.address().port });
}

main().catch(die);
