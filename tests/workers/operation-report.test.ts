import {expect,it,vi} from 'vitest';
import {operationQueries,operationReport} from '../../cloudflare/worker/platform-operation-report';
import type {Env} from '../../cloudflare/worker/types';
it('weights adaptive samples and excludes unknown queue waits without SQL interpolation',()=>{
 const q=operationQueries('safe_dataset',1000,new URLSearchParams({operation:"x' OR 1=1",source:'mcp'}));
 expect(q.measurements).not.toContain("x' OR");expect(q.measurements).toContain("blob4 = 'mcp'");
 expect(q.measurements).toContain('SUM(_sample_interval)');expect(q.queue).toContain('double4 >= 0');
});
it('does not turn missing observations into zero latency or claim unsampled counts',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({data:[{kind:'repository',operation:'repo_commit',source:'mcp',traffic:'ordinary',actor:'token',outcome:'ok',requests:'40',sampling:4,p50:null,p95:'NaN',p99:23}]})).mockResolvedValueOnce(Response.json({data:[]}));
 const env={OPERATION_METRICS:'on',CF_ACCOUNT_ID:'0'.repeat(32),SITE_EVENTS_DATASET:'safe_dataset',ANALYTICS_READ_TOKEN:'test-only'}as Env;
 const report=await operationReport(env,new URLSearchParams({range:'1h'}),fetcher,10000000);
 expect(report.status).toBe('ok');expect(report.rows[0]).toMatchObject({requests:40,p50:null,p95:null,p99:23,queueWaitP95:null,estimated:true});
 expect(report.window.end-report.window.start).toBe(3600000);
});
