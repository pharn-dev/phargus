// Count what the agent wrote: bytes, lines, and the backpressure events its sample lines report.

/**
 * Read an NDJSON stream to its end. Only lines that carry a `backpressure` object are parsed; a
 * malformed one rejects. A final line without a newline is counted too.
 * @param {NodeJS.ReadableStream} source
 */
export async function countNdjson(source) {
  source.setEncoding('utf8');
  const counts = { bytes: 0, lines: 0, bpEvents: 0 };
  const take = (line) => {
    counts.lines += 1;
    if (line.includes('"backpressure":')) counts.bpEvents += JSON.parse(line).backpressure.events;
  };
  let pending = '';
  for await (const chunk of source) {
    counts.bytes += Buffer.byteLength(chunk);
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) take(line);
  }
  if (pending !== '') take(pending);
  return counts;
}
