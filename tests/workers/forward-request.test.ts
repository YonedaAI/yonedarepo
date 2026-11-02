import { expect, it, vi } from 'vitest';
import { forwardRequest } from '../../cloudflare/worker/forward-request';

const binding = (fetch: (req: Request) => Promise<Response> | Response) => ({ fetch } as Fetcher);
const url = 'https://binding/upload';
function unfinished() {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array([1, 2])); },
    cancel,
  });
  return { req: new Request(url, { method: 'POST', body }), cancel };
}

it('preserves bytes and response metadata when the downstream reads the whole upload', async () => {
  const req = new Request(url, { method: 'POST', body: new Uint8Array([0, 255, 13, 10]) });
  const res = await forwardRequest(binding(async sent => {
    expect([...new Uint8Array(await sent.arrayBuffer())]).toEqual([0, 255, 13, 10]);
    return new Response('saved', { status: 201, headers: { 'x-result': 'ok' } });
  }), req);
  expect([res.status, res.headers.get('x-result'), await res.text()]).toEqual([201, 'ok', 'saved']);
});

it('keeps a duplex upload alive until its response finishes reading it', async () => {
  let source: ReadableStreamDefaultController<Uint8Array>;
  const req = new Request(url, { method: 'POST', body: new ReadableStream({ start(c) { source = c; } }) });
  const res = await forwardRequest(binding(sent => new Response(sent.body)), req);
  const reader = res.body!.getReader();
  source!.enqueue(new Uint8Array([1]));
  expect((await reader.read()).value).toEqual(new Uint8Array([1]));
  source!.enqueue(new Uint8Array([2]));
  source!.close();
  expect((await reader.read()).value).toEqual(new Uint8Array([2]));
  expect((await reader.read()).done).toBe(true);
});

it('cancels a body the downstream rejects without a response body', async () => {
  const { req, cancel } = unfinished();
  const res = await forwardRequest(binding(() => new Response(null, { status: 401 })), req);
  expect(res.status).toBe(401);
  expect(cancel).toHaveBeenCalledOnce();
});

it('cancels both sides when the response reader disconnects', async () => {
  const { req, cancel } = unfinished();
  const outputCancel = vi.fn();
  const res = await forwardRequest(binding(() => new Response(new ReadableStream({ cancel: outputCancel }))), req);
  await res.body!.cancel('gone');
  expect(cancel).toHaveBeenCalledOnce();
  expect(outputCancel).toHaveBeenCalledOnce();
});

it('stops the upload and preserves a downstream failure', async () => {
  const { req, cancel } = unfinished();
  const failure = new Error('binding failed');
  await expect(forwardRequest(binding(() => { throw failure; }), req)).rejects.toBe(failure);
  expect(cancel).toHaveBeenCalledOnce();
});

it('stops the upload if the response stream fails', async () => {
  const { req, cancel } = unfinished();
  const failure = new Error('stream failed');
  const res = await forwardRequest(binding(() => new Response(new ReadableStream({ start(c) { c.error(failure); } }))), req);
  await expect(res.text()).rejects.toBe(failure);
  expect(cancel).toHaveBeenCalledOnce();
});

it('passes bodyless requests and their responses through directly', async () => {
  const req = new Request(url);
  const res = new Response('ok');
  expect(await forwardRequest(binding(sent => { expect(sent).toBe(req); return res; }), req)).toBe(res);
});
