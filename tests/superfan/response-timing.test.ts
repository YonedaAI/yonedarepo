import { afterEach, expect, it, vi } from 'vitest';
import { deferred } from '../../cloudflare/worker/background';
import { log, served } from '../../cloudflare/worker/log';
import { responseTimed } from '../../cloudflare/worker/response-timing';
import type { Env } from '../../cloudflare/worker/types';

afterEach(() => vi.restoreAllMocks());

it('records the response boundary without waiting for background work or consuming the body', async () => {
  const lines = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(40);
  let finish!: () => void;
  const background = new Promise<void>(resolve => { finish = resolve; });
  const env = { RESPONSE_LATENCY: 'on' } as Env;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('hello')); controller.close(); } });
  const answer = new Response(body);
  const kept: Promise<unknown>[] = [];
  const result = await served({env,req:new Request('https://site.test/person/repo'),waitUntil:work=>{kept.push(work);}},
    () => responseTimed(env,async () => { deferred(()=>background); return answer; }));
  expect(kept).toHaveLength(1);
  expect(result.bodyUsed).toBe(false);
  expect(await result.text()).toBe('hello');
  const timing = lines.mock.calls.map(c => JSON.parse(String(c[0]))).find(l => l.event === 'http.response');
  expect(timing).toMatchObject({elapsed_ms:30,status:200});
  finish();
});

it('keeps thrown failures and disabled measurement behavior intact', async () => {
  const info=vi.spyOn(log,'info').mockImplementation(()=>{});
  const failure=new Error('request failure');
  await expect(responseTimed({RESPONSE_LATENCY:'on'} as Env,async()=>{throw failure;})).rejects.toBe(failure);
  expect(info).toHaveBeenCalledWith('http.response',expect.objectContaining({status:500}));
  info.mockClear();
  const answer=new Response('plain');
  expect(await responseTimed({} as Env,async()=>answer)).toBe(answer);
  expect(info).not.toHaveBeenCalled();
});
