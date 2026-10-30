// What Git makes of an upload-pack answer, for tests that serve one to it.
/** Reads an upload-pack answer as Git does (`fetch-pack`): `ERR` where it reads pkt-lines
 * is `remote error`; once the pack starts (v2's `packfile` section, or v0 after the NAK with
 * side-band) every packet is side-band: 1 pack, 2 progress (`remote:`), 3 `remote error`;
 * any other first byte is Git's "bad band". */
export function asGit(bytes: Uint8Array, v2: boolean) {
  const out = { error: null as string | null, badBand: null as number | null, pack: 0, progress: [] as string[] };
  let banded = false;
  for (let at = 0; at + 4 <= bytes.length; ) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(at, at + 4)), 16);
    at += 4;
    if (length <= 4) {
      if (banded && length === 0) return out;
      continue;
    }
    const payload = bytes.subarray(at, at + length - 4);
    at += length - 4;
    const text = new TextDecoder().decode(payload);
    if (!banded) {
      if (text.startsWith('ERR ')) return { ...out, error: text.slice(4).trim() };
      if (v2 ? text === 'packfile\n' : text === 'NAK\n') banded = true;
      continue;
    }
    if (payload[0] === 1) out.pack += payload.length - 1;
    else if (payload[0] === 2) out.progress.push(text.slice(1).trim());
    else if (payload[0] === 3) return { ...out, error: text.slice(1).trim() };
    else return { ...out, badBand: payload[0] };
  }
  return out;
}
