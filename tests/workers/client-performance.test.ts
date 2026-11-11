import { afterEach, expect, it, vi } from 'vitest';
import { clientPerformance } from '../../cloudflare/worker/client-performance';
import type { Env } from '../../cloudflare/worker/types';
const origin='https://site.test';
const browser={origin,'user-agent':'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36','sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-ch-ua':'"Chromium";v="140"','accept-language':'en','content-type':'application/json'};
const body={path:'/person/private/files/secret.md',navigation:'navigation-1234',metrics:[{name:'api_ms',ms:200,status:409,requestId:'request-12345'}]};
const request=(value:unknown=body,headers=browser)=>new Request(`${origin}/api/client-performance`,{method:'POST',headers,body:JSON.stringify(value)});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('records bounded client reports without touching repository or account state',async()=>{
 const points:AnalyticsEngineDataPoint[]=[];const calls=vi.fn(()=>{throw Error('telemetry must not fetch');});vi.stubGlobal('fetch',calls);
 vi.spyOn(console,'log').mockImplementation(()=>{});
 const env={OPERATION_METRICS:'on',CLIENT_PERFORMANCE:'on',OPERATION_DETAIL_EVERY:'1',SITE_EVENTS:{writeDataPoint:(p:AnalyticsEngineDataPoint)=>points.push(p)}} as Env;
 const result=await clientPerformance(request(),env);
 expect(result.status).toBe(204);expect(points).toHaveLength(1);expect(points[0].blobs?.[6]).toBe('refused');
 expect(JSON.stringify(points)).not.toMatch(/person|private|secret|request-12345|navigation-1234/);expect(calls).not.toHaveBeenCalled();vi.unstubAllGlobals();
});
it('silently drops cross-origin, disabled, oversized and invalid measurements',async()=>{
 const write=vi.fn();const env={OPERATION_METRICS:'on',CLIENT_PERFORMANCE:'on',SITE_EVENTS:{writeDataPoint:write}} as Env;
 for(const req of [request(body,{...browser,origin:'https://evil.test'}),request({...body,metrics:[{name:'api_ms',ms:-1}]}),request({...body,path:'//evil.test/'}),request({...body,path:'x'.repeat(5000)})])expect((await clientPerformance(req,env)).status).toBe(204);
 await clientPerformance(request(),{...env,CLIENT_PERFORMANCE:'off'});expect(write).not.toHaveBeenCalled();
});
