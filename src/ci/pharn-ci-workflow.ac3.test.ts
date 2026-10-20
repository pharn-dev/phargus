import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AC-3: the `Test` job of `.github/workflows/ci.yml` checks out full history, runs
// `npm run test:coverage`, has job permissions of exactly `contents: read` + `pull-requests: write`,
// and runs the pinned pharn-ci step only on `pull_request` / `merge_group`; no workflow uses
// `pull_request_target`, and `npm run check:pins` stays green.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const WORKFLOWS_DIR = join(repoRoot, '.github', 'workflows');
const CI_WORKFLOW = join(WORKFLOWS_DIR, 'ci.yml');
const PHARN_CI_USES = 'pharn-dev/pharn-ci@a88e62a8febf5cd9a77b8e0252cd060c3b94782c';
const CHECK_PINS_TIMEOUT_MS = 60_000;

/**
 * On Windows, `npm` resolves to a `.cmd` shim. `spawnSync('npm', …)` fails with ENOENT because a
 * `.cmd` file is not directly executable, and `spawnSync('npm.cmd', …)` then fails with EINVAL
 * because a `.cmd` file can only run through a shell. `shell: true` on win32 routes the call
 * through `cmd.exe`, which resolves and runs it correctly; elsewhere it is a no-op either way.
 */
const NPM_SPAWN_OPTIONS = { shell: process.platform === 'win32' } as const;

/** The line with any trailing ` # comment` removed, right-trimmed. */
function stripComment(line: string): string {
  const hash = line.search(/(^|\s)#/);
  return (hash === -1 ? line : line.slice(0, hash)).trimEnd();
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The workflow's lines without comments and blank lines. */
function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(stripComment)
    .filter((line) => line.trim() !== '');
}

/** The `test:` job's lines: from `  test:` to the next two-space-indented job key or a top-level key. */
function testJobBlock(lines: string[]): string[] {
  const start = lines.findIndex((line) => /^ {2}test:\s*$/.test(line));
  expect(start, 'no `  test:` job in ci.yml').toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (indentOf(line) <= 2) break;
    block.push(line);
  }
  return block;
}

/** The lines nested under the job-level `key:` (four-space indent) of a job block. */
function jobSection(block: string[], key: string): string[] | undefined {
  const start = block.findIndex((line) => new RegExp(`^ {4}${key}:\\s*$`).test(line));
  if (start === -1) return undefined;
  const section: string[] = [];
  for (let i = start + 1; i < block.length; i++) {
    const line = block[i] ?? '';
    if (indentOf(line) <= 4) break;
    section.push(line);
  }
  return section;
}

/** The job's steps, each as its own lines, the first line's `- ` replaced by spaces. */
function jobSteps(block: string[]): string[][] {
  const section = jobSection(block, 'steps');
  expect(section, 'the test job has no `steps:`').toBeDefined();
  const lines = section ?? [];
  const first = lines.find((line) => /^\s*- /.test(line));
  if (first === undefined) return [];
  const itemIndent = indentOf(first);
  const steps: string[][] = [];
  for (const line of lines) {
    if (indentOf(line) === itemIndent && line.trimStart().startsWith('- ')) {
      steps.push([`${' '.repeat(itemIndent + 2)}${line.trimStart().slice(2)}`]);
    } else {
      steps[steps.length - 1]?.push(line);
    }
  }
  return steps;
}

/** A step's own `key:` value; a block scalar (`|`, `>-`, …) is joined from its deeper lines. */
function stepField(step: string[], key: string): string | undefined {
  const fieldIndent = indentOf(step[0] ?? '');
  for (let i = 0; i < step.length; i++) {
    const line = step[i] ?? '';
    if (indentOf(line) !== fieldIndent) continue;
    const match = new RegExp(`^\\s*${key}:\\s*(.*)$`).exec(line);
    if (match === null) continue;
    const value = (match[1] ?? '').trim();
    if (!/^[|>][-+]?\d*$/.test(value)) return unquote(value);
    const parts: string[] = [];
    for (let j = i + 1; j < step.length && indentOf(step[j] ?? '') > fieldIndent; j++) {
      parts.push((step[j] ?? '').trim());
    }
    return parts.join(' ');
  }
  return undefined;
}

/** A step's `with:` entries as `key -> value`. */
function stepWith(step: string[]): Map<string, string> {
  const fieldIndent = indentOf(step[0] ?? '');
  const entries = new Map<string, string>();
  const start = step.findIndex(
    (line) => indentOf(line) === fieldIndent && /^\s*with:\s*$/.test(line),
  );
  if (start === -1) return entries;
  for (let i = start + 1; i < step.length && indentOf(step[i] ?? '') > fieldIndent; i++) {
    const match = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(step[i] ?? '');
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.set(match[1], unquote(match[2]));
    }
  }
  return entries;
}

function readTestJob(): string[] {
  return testJobBlock(meaningfulLines(readFileSync(CI_WORKFLOW, 'utf8')));
}

function findPharnCiStep(steps: string[][]): string[] | undefined {
  return steps.find((step) => stepField(step, 'uses') === PHARN_CI_USES);
}

describe('ci.yml Test job (pharn-ci wiring)', () => {
  it('AC-3: keeps the name Test, checks out with fetch-depth 0 and runs npm run test:coverage', () => {
    const block = readTestJob();
    expect(block.some((line) => /^ {4}name:\s*['"]?Test['"]?\s*$/.test(line))).toBe(true);

    const steps = jobSteps(block);
    const checkout = steps.find((step) => stepField(step, 'uses')?.startsWith('actions/checkout@'));
    expect(checkout, 'no actions/checkout step in the test job').toBeDefined();
    expect(stepWith(checkout ?? []).get('fetch-depth')).toBe('0');

    expect(steps.some((step) => stepField(step, 'run') === 'npm run test:coverage')).toBe(true);
  });

  it('AC-3: has job-level permissions of exactly contents: read and pull-requests: write', () => {
    const permissions = jobSection(readTestJob(), 'permissions');
    expect(permissions, 'the test job has no job-level `permissions:`').toBeDefined();
    const entries = (permissions ?? [])
      .map((line) => /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line))
      .map((match) => `${match?.[1] ?? '?'}: ${unquote(match?.[2] ?? '')}`)
      .sort();
    expect(entries).toEqual(['contents: read', 'pull-requests: write']);
  });

  it('AC-3: runs the pinned pharn-ci step only on pull_request and merge_group events', () => {
    const step = findPharnCiStep(jobSteps(readTestJob()));
    expect(step, `no step using ${PHARN_CI_USES} in the test job`).toBeDefined();
    const condition = stepField(step ?? [], 'if');
    expect(condition, 'the pharn-ci step has no `if:`').toBeDefined();
    const events = [
      ...(condition ?? '').matchAll(/github\.event_name\s*==\s*['"]([^'"]+)['"]/g),
    ].map((match) => match[1]);
    expect([...new Set(events)].sort()).toEqual(['merge_group', 'pull_request']);
    expect(condition ?? '').not.toMatch(/github\.event_name\s*!=/);
  });

  it('AC-3: with pharn-ci wired in, no workflow uses pull_request_target and check:pins exits 0', () => {
    expect(findPharnCiStep(jobSteps(readTestJob()))).toBeDefined();

    const offenders = readdirSync(WORKFLOWS_DIR)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .filter((name) =>
        meaningfulLines(readFileSync(join(WORKFLOWS_DIR, name), 'utf8')).some((line) =>
          line.includes('pull_request_target'),
        ),
      );
    expect(offenders).toEqual([]);

    const pins = spawnSync('npm', ['run', 'check:pins'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: CHECK_PINS_TIMEOUT_MS,
      ...NPM_SPAWN_OPTIONS,
    });
    expect(pins.error, String(pins.error)).toBeUndefined();
    expect(pins.status, `${pins.stdout}\n${pins.stderr}`).toBe(0);
  });
});
