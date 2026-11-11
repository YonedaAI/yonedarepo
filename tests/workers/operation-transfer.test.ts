import { expect, it } from 'vitest';
import { PackStats, sendStored } from '../../cloudflare/worker/repo-pack-stream';
it('does not label a stored transfer successful when its source fails',async()=>{
  const stats=new PackStats(false);
  const stored={size:3,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([1,2,3]));c.error(Error('interrupted'));}})} as R2ObjectBody;
  const response=sendStored(new Uint8Array([1]),stored,65515,stats);
  await expect(response.arrayBuffer()).rejects.toThrow();await stats.ended;
  expect(stats.outcome).toBe('failed');expect(stats.sentBytes).toBe(0);
});
it('distinguishes completed and cancelled streams and settles only once',async()=>{
 const stats=new PackStats(false);stats.begin();stats.sent(new Uint8Array([1]));stats.finish('cancelled');stats.finish('ok');await stats.ended;
 expect(stats.outcome).toBe('cancelled');expect(stats.sentBytes).toBe(1);
 const ok=new PackStats(false);const result=sendStored(new Uint8Array([1]),{size:3,body:new Blob([new Uint8Array([1,2,3])]).stream()} as R2ObjectBody,65515,ok);
 await result.arrayBuffer();await ok.ended;expect(ok.outcome).toBe('ok');expect(ok.sentBytes).toBe(3);
});
