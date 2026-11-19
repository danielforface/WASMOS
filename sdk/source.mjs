// Also serialized into the Studio. Keep this function independent of module state.
export function stripAutoSdk(source) {
  const start = '// --- WASM ARCHITECT STUDIO AUTO-INJECTED STDLIB START ---';
  const end = '// --- WASM ARCHITECT STUDIO AUTO-INJECTED STDLIB END ---';
  let body = source.replace(/^\uFEFF/, '');
  while (true) {
    const prefix = /^[\t \r\n]*/.exec(body)[0].length;
    const lineEnd = body.indexOf('\n', prefix);
    if (body.slice(prefix, lineEnd < 0 ? undefined : lineEnd).trimEnd() !== start) return body;
    const marker = /^\/\/ --- WASM ARCHITECT STUDIO AUTO-INJECTED STDLIB (START|END) ---[\t ]*\r?$/gm;
    marker.lastIndex = lineEnd < 0 ? body.length : lineEnd + 1;
    const close = marker.exec(body);
    if (!close || close[1] !== 'END' || !close[0].startsWith(end)) throw Error('Malformed generated SDK prelude; app source was not changed.');
    body = body.slice(marker.lastIndex).replace(/^\r?\n/, '');
  }
}
export function withSdk(source, sdk) {
  return sdk + '\n' + stripAutoSdk(source);
}
