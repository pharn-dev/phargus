// TEMPORARY diagnostic for PR #186, removed before merge: how does a Windows stdout pipe behave
// with a stalled reader when written by fs.write instead of process.stdout?
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

const CHILD = `
import { fstatSync, write } from 'node:fs';
const mode = process.argv[2];
let st;
try { const s = fstatSync(1); st = { fifo: s.isFIFO(), file: s.isFile(), chr: s.isCharacterDevice(), sock: s.isSocket(), mode: s.mode }; } catch (e) { st = String(e); }
process.stderr.write('stat ' + JSON.stringify(st) + '\\n');
const start = Date.now();
const line = Buffer.from(JSON.stringify({ pad: 'x'.repeat(430) }) + '\\n');
let inFlight = false, written = 0, pending = 0;
setInterval(() => {
  if (mode === 'fswrite' || mode === 'fswrite-touch') {
    if (inFlight) { pending += 1; return; }
    inFlight = true;
    write(1, line, 0, line.length, null, (err, n) => { inFlight = false; if (err) process.stderr.write('err ' + err.message + '\\n'); else written += n; });
  }
}, 2);
setInterval(() => {
  const extra = mode === 'fswrite-touch' ? ' ' + process.stdout.writableLength : '';
  process.stderr.write('report ' + (Date.now() - start) + ' ' + written + ' ' + pending + extra + '\\n');
}, 100);
`;

function run(dir: string, mode: string): Promise<string> {
  const file = join(dir, 'child.mjs');
  writeFileSync(file, CHILD);
  return new Promise((done) => {
    const child = spawn(process.execPath, [file, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pause();
    child.stdout.on('error', () => undefined);
    let err = '';
    const arrivals: number[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      err += c;
      arrivals.push(Date.now());
    });
    const t0 = Date.now();
    setTimeout(() => {
      let gap = 0;
      const a = [t0, ...arrivals, Date.now()];
      for (let i = 1; i < a.length; i += 1) gap = Math.max(gap, (a[i] ?? 0) - (a[i - 1] ?? 0));
      const lines = err.trim().split('\n');
      child.kill();
      done(
        `mode=${mode} maxGap=${String(gap)} first=${lines[0] ?? ''} last=${lines[lines.length - 1] ?? ''}`,
      );
    }, 5000);
  });
}

describe.runIf(process.platform === 'win32')('TEMP windows stdout diag', () => {
  it('prints observations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phargus-diag-'));
    for (const mode of ['stat', 'fswrite', 'fswrite-touch']) {
      console.log(`[win-diag] ${await run(dir, mode)}`);
    }
  }, 60_000);
});
