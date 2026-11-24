// Reader for the `pipe` variant: the target's stdout is a pipe into this process, which consumes
// the agent's NDJSON the way a log shipper would. Forked by bench/overhead.mjs; once the target has
// exited (end of stdin), it answers the 'counts' request with what it read.
import { die, serve } from './ipc.mjs';
import { countNdjson } from './ndjson-count.mjs';

const counted = countNdjson(process.stdin);
// A read or parse failure ends this process; the harness's pending request then fails with it.
counted.then(undefined, die);

serve({
  async counts() {
    return { type: 'counts', ...(await counted) };
  },
  exit() {
    process.exit(0);
  },
});
