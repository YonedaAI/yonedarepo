import { afterEach, expect, it, vi } from 'vitest';
import { capturePolicy, performanceRoute } from '../../cloudflare/worker/operation-context';
import { observeOperation, observeRequest } from '../../cloudflare/worker/operation-observation';
import { carriedHeaders, inScope } from '../../cloudflare/worker/request-scope';
import type { Env } from '../../cloudflare/worker/types';

afterEach(() => vi.restoreAllMocks());
function setup(every = '1') {
  const points: AnalyticsEngineDataPoint[] = [];
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, 'log').mockImplementation((line) => lines.push(JSON.parse(String(line))));
  const env = { OPERATION_METRICS: 'on', OPERATION_DETAIL_EVERY: every, REQUEST_IDS: 'on',
    SITE_EVENTS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) } } as Env;
  const req = new Request('https://site.test/api/v1/repos/r0123456789abcdef0123/commits?token=private',
    { headers: { 'cf-ray': '8f1c2d3e4a5b6c7d-SJC', 'x-request-id': 'forged-id', 'user-agent': 'Mozilla/5.0' } });
  return { env, req, points, lines };
}

it('connects concurrent repository commands to the initiating route without leaking payloads', async () => {
  const s = setup();
  const seen: (Record<string,string>|undefined)[] = [];
  await inScope({env:s.env, req:s.req}, () => observeRequest(s.env,s.req,async () => {
    await Promise.all(['repo_commit','repo_sessions'].map(operation => observeOperation(s.env,
      {kind:'repository',operation,repo:'r0123456789abcdef0123',actor:'anonymous'},async()=>{
        seen.push(carriedHeaders()); return {commit:'do not log content'};
      })));
    return new Response('private body');
  }));
  const root=s.lines.find(l=>l.event==='request.operation');
  const children=s.lines.filter(l=>l.event==='repository.operation');
  expect(children).toHaveLength(2);
  expect(new Set(children.map(l=>l.span_id)).size).toBe(2);
  for(const c of children){expect(c.parent_span_id).toBe(root?.span_id);expect(c.origin).toBe('GET /api/v1/repos/:repo/commits');expect(c.request_id).toBe('8f1c2d3e4a5b6c7d-SJC');}
  for(const h of seen){expect(h?.['x-request-id']).toBe('8f1c2d3e4a5b6c7d-SJC');expect(h?.['x-yoneda-capture']).toBe('1');}
  expect(s.points).toHaveLength(3);
  const aggregates=JSON.stringify(s.points);expect(aggregates).not.toContain('r0123456789abcdef0123');expect(aggregates).not.toContain('8f1c2d3e4a5b6c7d');
  for(const secret of ['private','do not log','forged-id'])expect(JSON.stringify(s.lines)).not.toContain(secret);
});

it('retains complete measurements when details are sampled away, including refusals and failures',async()=>{
  const s=setup('10');vi.spyOn(Math,'random').mockReturnValue(.99);
  await inScope({env:s.env,req:s.req},async()=>{
    await observeOperation(s.env,{kind:'repository',operation:'repo_commit'},async()=>({error:{code:'CONFLICT'}}));
    await expect(observeOperation(s.env,{kind:'repository',operation:'repo_commit'},async()=>{throw Error('secret request body');})).rejects.toThrow();
  });
  expect(s.points).toHaveLength(2);
  expect(s.points.map(p=>p.blobs?.[6])).toEqual(['refused','failed']);
  expect(s.lines).toHaveLength(1);expect(s.lines[0].outcome).toBe('failed');
  expect(JSON.stringify(s.lines)).not.toContain('secret request body');
});

it('expires full capture without a timer or network request and fails closed on invalid expiry',()=>{
  const now=Date.UTC(2026,10,11);
  const env={OPERATION_METRICS:'on',OPERATION_FULL_UNTIL:new Date(now+48*3_600_000).toISOString()};
  expect(capturePolicy(env,now).detailEvery).toBe(1);
  expect(capturePolicy(env,now+48*3_600_000).detailEvery).toBe(10);
  expect(capturePolicy({...env,OPERATION_FULL_UNTIL:'bad'},now).fullUntil).toBeNull();
});

it('cannot change a product result when the analytics sink fails',async()=>{
  const s=setup();s.env.SITE_EVENTS={writeDataPoint:()=>{throw Error('sink unavailable');}}as AnalyticsEngineDataset;
  const result=await inScope({env:s.env,req:s.req},()=>observeOperation(s.env,{kind:'repository',operation:'repo_head'},async()=>({version:42})));
  expect(result).toEqual({version:42});
});

it('normalizes browser paths without retaining repository or file names',()=>{
  expect(performanceRoute('/alice/private-repo/files/secret.md')).toBe('/:owner/:repo/files');
  for(const p of ['//other.test/','/repo?token=secret','/repo#private','/api/v1/repos'])expect(performanceRoute(p)).toBeNull();
});

it('keeps queue causality across retries and distinguishes their completion from the parent',async()=>{
  const { operationCarrier, withCarrier }=await import('../../cloudflare/worker/operation-carrier');
  const { carriedQueue }=await import('../../cloudflare/worker/request-scope');
  const { markOperationOutcome }=await import('../../cloudflare/worker/operation-observation');
  const s=setup();let body: any;let carrier: ReturnType<typeof operationCarrier>;
  await inScope({env:s.env,req:s.req},()=>observeRequest(s.env,s.req,async()=>{
    carrier=operationCarrier();
    await carriedQueue({send:async(value:unknown)=>{body=value;}} as Queue<any>).send({v:1,repo_id:'r0123456789abcdef0123',job_id:'job-safe',kind:'derive'});
    return new Response();
  }));
  for(const attempt of [1,2])await inScope({env:s.env,job:body},()=>withCarrier(s.env,body.observation,()=>observeOperation(s.env,{kind:'background',operation:'derive',source:'queue',attempt},async()=>{markOperationOutcome(attempt===1?'retry':'ok');})));
  const jobs=s.lines.filter(l=>l.event==='background.operation');
  expect(jobs.map(j=>j.outcome)).toEqual(['retry','ok']);
  expect(jobs.map(j=>j.attempt)).toEqual([1,2]);
  for(const j of jobs){expect(j.parent_span_id).toBe(carrier?.span);expect(j.origin).toBe('GET /api/v1/repos/:repo/commits');}
});

it('expires full-capture metadata carried by a delayed job',async()=>{
 const { withCarrier }=await import('../../cloudflare/worker/operation-carrier');
 const s=setup('10');vi.spyOn(Math,'random').mockReturnValue(.99);
 await withCarrier(s.env,{requestId:'request-old',span:'parent-old',origin:'POST /api/v1/repos/:repo/commits',source:'rest',traffic:'ordinary',selected:true,fullUntil:'2020-01-01T00:00:00.000Z'},()=>observeOperation(s.env,{kind:'background',operation:'derive'},async()=>true));
 expect(s.points).toHaveLength(1);expect(s.lines).toHaveLength(0);
});
