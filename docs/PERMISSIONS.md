# Running Phargus under the Node permission model

Phargus requires Node.js 22.18 or newer, where the permission model is enabled with `--permission`
(stable since Node 22.13, and on Node 24). The older `--experimental-permission` flag is not
supported by the agent.

Each module needs only the grants for what it does. The agent needs file system grants only, except
for `sampleAllocations` (below); the analyzer and the plugin runner also start threads or processes.

## Agent (`@pharn-dev/phargus/agent`)

```bash
node --permission \
  --allow-fs-read=<app dir> \
  --allow-fs-read=<path to node_modules/phargus> \
  --allow-fs-write=<NDJSON output file and <file>.1, or their directory> \
  --allow-fs-read=<NDJSON output file> \
  --allow-fs-write=<heap snapshot dir> \
  --require @pharn-dev/phargus/agent app.js
```

| Grant                                    | Needed for                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `--allow-fs-read=<app dir>`              | Loading your app, and reading `phargus.config.json` / `phargus.config.js` from the cwd |
| `--allow-fs-read=<node_modules/phargus>` | Loading the agent itself                                                               |
| `--allow-fs-read=<PHARGUS_CONFIG file>`  | Reading the config file that `PHARGUS_CONFIG` pins                                     |
| `--allow-fs-write=<output path>`         | The NDJSON export to a file (`output` other than `'stdout'` or `'none'`)               |
| `--allow-fs-write=<output path>.1`       | Renaming a full output file to `<file>.1` (unless `outputMaxBytes` is `0`)             |
| `--allow-fs-read=<output path>`          | The same rename: Node checks read access on the file it moves                          |
| `--allow-fs-write=<snapshot dir>`        | `takeHeapSnapshot({ dir })`, which also needs `--allow-fs-read=<snapshot dir>`         |

`output: 'stdout'` needs no write grant. With the default size bound, a file output missing either
rotation grant disables the agent at start, before any file is opened; one
`--allow-fs-write=<directory>` covers both write paths. Leave out the write grants for features you
do not use.

With `PHARGUS_CONFIG` set, the agent reads only that file for its config. A `.js` config is
executed with only a read grant, so prefer a pinned `.json` file, or a directory only the operator
can write.

The agent spawns no worker threads and no child processes, so none of `--allow-worker`,
`--allow-child-process`, `--allow-addons` or `--allow-wasi` is needed for it.

`sampleAllocations` opens a `node:inspector` session, which the permission model restricts. On
Node 22 it is always refused under `--permission`: the release has no flag to grant it. Node
releases that have `--allow-inspector` (24.13 does; 24.11 does not) allow it with that flag, which
Node itself warns "could invalidate the permission model". Without the grant, `sampleAllocations`
rejects with an `allocation sampling failed: Access to this API has been restricted` error, and
nothing else in the agent is affected.

## Analyzer (`@pharn-dev/phargus/analyzer`)

Heap-snapshot summaries and diffs and stack-trace symbolization run in Worker Threads:

| Grant                                     | Needed for                                  |
| ----------------------------------------- | ------------------------------------------- |
| `--allow-worker`                          | Starting the worker pool                    |
| `--allow-fs-read=<node_modules/phargus>`  | Loading the worker files                    |
| `--allow-fs-read=<snapshot or build dir>` | Reading the snapshots, built files and maps |

Analyzer workers inherit the host's flags, except entry-point and tooling flags such as
`--input-type`, `-e`, `-p`, `--test*`, `--watch*` and `--inspect*`, which are dropped. A preloaded
agent's `--require` or `--import` reaches the workers too, but the agent starts in the main thread
only, so pool workers write no sample lines.

## Plugin runner (`@pharn-dev/phargus/plugin-runner`)

Rules run in `isolated-vm` inside a forked child process:

| Grant                                        | Needed for                                          |
| -------------------------------------------- | --------------------------------------------------- |
| `--allow-child-process`                      | Forking the sandbox process                         |
| `--allow-addons`                             | Loading `isolated-vm` (a native addon) in the child |
| `--allow-fs-read=<node_modules/phargus>`     | Loading the sandbox child script                    |
| `--allow-fs-read=<node_modules/isolated-vm>` | Loading `isolated-vm`                               |
| `--allow-fs-read=<rules dir>`                | `loadRulesDirectory(dir)`                           |

The sandbox child is forked with `--no-node-snapshot` (which `isolated-vm` needs) plus every
`--permission`, `--experimental-permission` and `--allow-*` flag from the host's `execArgv`, so it
runs under the same permission model as the host. Without `--allow-addons`, every rule fails with
`PHARGUS_ISOLATED_VM_MISSING`, and the host keeps running.

The child gets a scrubbed environment: `PATH` (plus `SystemRoot` on Windows) and
`PHARGUS_ENABLED=false`, nothing else. `NODE_OPTIONS` is dropped, so an agent the host preloads
there does not start in the child, and the child holds none of the host's secrets. Its stdout is
ignored; it reports on stderr only.

## Collector, dashboard and OpenTelemetry export

| Grant                                                                                          | Needed for                          |
| ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| `--allow-fs-read=<node_modules/phargus>`                                                       | Loading the modules                 |
| `--allow-fs-read`, `--allow-fs-write=<the file>` and `--allow-fs-write=<the file>.compact.tmp` | Window persistence (`persist.path`) |
| `--allow-fs-write=<the file>`                                                                  | The file alert sink                 |

Window persistence compacts the file by writing `<the file>.compact.tmp` next to it and renaming
it over the file, so it needs write access to both paths (one `--allow-fs-write` flag each, or
one for their directory), and the directory must be writable by the process's user. With write access to the file alone, persistence works
until the file reaches `maxBytes`; from then on every compaction fails, nothing more is appended,
and each failure is counted in `collector.persistence.failed` with one process warning per run of
failures. Windows, alerts and `consume()` are not affected. Recent Node releases refuse `fchmod`
and `fdatasync` on a file descriptor under the permission model, so there compaction skips both:
the temp file keeps the mode it was created with, and the rewrite is not flushed to disk before
the rename.

Only the agent, plugin-runner and window persistence grants are exercised by tests that run under
`--permission` (`permission-model.ac2/ac3`, `agent-output-rotation.integration.test.ts`,
`plugin-runner-caps.integration.test.ts` and `collector-persistence-permission.integration.test.ts`). The analyzer, dashboard and other
collector rows follow from the files and threads each module uses.

## When a grant is missing

In the agent, a denied write disables only that feature, with a typed error that never crashes the
host:

- **NDJSON export:** the agent writes one `[phargus] agent disabled: ...` line to stderr, starts no
  sampling, and your app keeps running.
- **Heap snapshot:** `takeHeapSnapshot` rejects with an `PhargusPermissionError`. Its `scope` and
  `resource` properties name the denied scope and the absolute path, and its message names the flag
  that would grant it. No file is written.

To check a grant yourself, use Node's own `process.permission.has(scope, path)`. When the permission
model is off, `process.permission` is undefined and nothing is denied.
