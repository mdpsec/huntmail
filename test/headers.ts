/** What the runtime gives an Email Worker as `message.headers`: the top-level header block, unfolded. */
export function headersOf(raw: Uint8Array): Headers {
  const text = new TextDecoder().decode(raw.subarray(0, 65536));
  const m = text.search(/\r?\n\r?\n/);
  const block = m === -1 ? "" : text.slice(0, m);
  const h = new Headers();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    try {
      h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
    } catch {
      // invalid header name
    }
  }
  return h;
}
