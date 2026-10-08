export const response = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export const error = (code: string, message: string, status = 400) =>
  response({ error: { code, message } }, status);
export const now = () => Date.now();
export const safeId = (s: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(s);
export async function readJson(req: Request, limit = 32 * 1024) {
  const reader = req.body?.getReader();
  if (!reader) throw new Error('JSON body required');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error('Request exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const parsed = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('JSON object required');
  return parsed;
}
