//! Bound and sanitize the HTTP membrane around untrusted app code.
const requestHeaders = ['accept', 'content-type', 'if-match', 'if-none-match'];
const responseHeaders = ['content-type', 'content-language', 'etag'];
export async function boundedBody(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Application body limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
export async function appRequest(request: Request) {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of requestHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const body = ['GET', 'HEAD'].includes(request.method)
    ? null
    : await boundedBody(request.body, 1024 * 1024);
  return new Request(`https://app.invalid${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
  });
}
export async function appResponse(response: Response, request: Request, platformOrigin: string) {
  const headers = new Headers();
  for (const name of responseHeaders) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const location = response.headers.get('location');
  if (location) {
    if (!location.startsWith('/') || location.startsWith('//') || /[\\\r\n]/.test(location))
      throw new Error('External application redirect denied');
    headers.set('location', new URL(location, request.url).href);
  }
  headers.set('cache-control', 'no-store');
  headers.set(
    'content-security-policy',
    `sandbox allow-scripts allow-forms allow-same-origin; default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'; form-action 'self'; frame-ancestors ${platformOrigin}; base-uri 'self'`,
  );
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  const body = request.method === 'HEAD' ? null : await boundedBody(response.body, 2 * 1024 * 1024);
  return new Response(body, { status: response.status, headers });
}
export const missing = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
export function redirect(url: string, cookie?: string) {
  const headers = new Headers({
    location: url,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response(null, { status: 307, headers });
}
