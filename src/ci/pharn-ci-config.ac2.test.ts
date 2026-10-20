import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// AC-2: `.pharn/ci.yml` holds only the `coverage` key, with `file: coverage/lcov.info` and
// `threshold: 80`, has no tab, and is committable while PHARN's scratch under `.pharn/` stays ignored.
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CONFIG_PATH = join(repoRoot, '.pharn', 'ci.yml');

/** The line with any trailing ` # comment` removed, right-trimmed. */
function stripComment(line: string): string {
  const hash = line.search(/(^|\s)#/);
  return (hash === -1 ? line : line.slice(0, hash)).trimEnd();
}

/** A scalar with matching surrounding quotes removed. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}

interface ParsedConfig {
  topLevelKeys: string[];
  /** `key -> value` of the lines indented under `coverage:`. */
  coverage: Map<string, string>;
}

/** A line-by-line read of the settings file: top-level keys and the `coverage` block's entries. */
function parseConfig(text: string): ParsedConfig {
  const topLevelKeys: string[] = [];
  const coverage = new Map<string, string>();
  let current: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) {
      const colon = line.indexOf(':');
      current = colon === -1 ? line : line.slice(0, colon);
      topLevelKeys.push(current);
      continue;
    }
    if (current !== 'coverage') continue;
    const entry = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (entry?.[1] !== undefined && entry[2] !== undefined) {
      coverage.set(entry[1], unquote(entry[2]));
    }
  }
  return { topLevelKeys, coverage };
}

function checkIgnore(path: string): number | null {
  const result = spawnSync('git', ['check-ignore', path], { cwd: repoRoot, encoding: 'utf8' });
  expect(result.error, String(result.error)).toBeUndefined();
  return result.status;
}

describe('.pharn/ci.yml (pharn-ci settings)', () => {
  it('AC-2: has only the coverage key, file coverage/lcov.info, threshold 80, and no tab', () => {
    const text = readFileSync(CONFIG_PATH, 'utf8');
    expect(text.includes('\t')).toBe(false);

    const parsed = parseConfig(text);
    expect(parsed.topLevelKeys).toEqual(['coverage']);
    expect(parsed.coverage.get('file')).toBe('coverage/lcov.info');
    expect(parsed.coverage.get('threshold')).toBe('80');
  });

  it('AC-2: is not git-ignored while .pharn/writes-scope.json still is', () => {
    expect(checkIgnore('.pharn/ci.yml')).toBe(1);
    expect(checkIgnore('.pharn/writes-scope.json')).toBe(0);
  });
});
