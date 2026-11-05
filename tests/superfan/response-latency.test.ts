import { expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { httpTraffic } from '../../shared/http-traffic';
import { httpTimings } from '../../cloudflare/superfan/http-timing';
import { LATENCY_WINDOW_MS } from '../../cloudflare/superfan/http-latency';
import { watchHttp } from '../../cloudflare/superfan/http-watch';
import { migrate, MIGRATIONS } from '../../cloudflare/superfan/ledger-schema';
import { deps, testEnv, FRONT_SCRIPT, SCRIPT, traces } from './fake-platform';
import { aggregate } from '../../cloudflare/superfan/tail';
import { problems } from '../../cloudflare/superfan/signals';
import { invocationSignals, type Snapshot } from '../../cloudflare/superfan/signal-rules';

it('does not use mixed frontend invocation lifetimes as a calibrated response baseline', () => {
  const snapshot = {
    latencyCalibration: true,
    tail: { front_worker: { invocations: 76, errors: 0, exceptions: 0, errorLogs: 0,
      resourceKills: 0, pushRetries: 0, p95WallMs: 649, samples: [] } },
  } as unknown as Snapshot;
  const signals = invocationSignals('front_worker', snapshot, {
    'front_worker/p95_wall_ms': { value: 90, samples: 18 },
  });
  expect(signals.some(s => s.name === 'p95_wall_ms')).toBe(false);
  expect(signals.find(s => s.name === 'error_rate')?.value).toBe(0);
});

it('separates probes, scanner-shaped paths, assets, API, pages and marked traffic', () => {
  const ask = (path: string, own = false) => httpTraffic(`https://example.test${path}`, own);
  expect(['/health', '/phpmyadmin/phpinfo.php', '/.env.local', '/wp-admin/install.php',
    '/assets/app.js', '/api/v1/resolve/person/project', '/person/project', '/downloads/cli/LATEST']
    .map(p => ask(p))).toEqual(['health','scanner','scanner','scanner','asset','api','page','transfer']);
  expect(ask('/person/project', true)).toBe('own');
  expect(ask('/person/normal.php')).toBe('page');
});

const at = Date.UTC(2026, 10, 6);
const trace = (path: string, ready = 40, wall = 9000) => ({
  ...traces({ component: 'front_worker', count: 1, wallMs: wall, script: FRONT_SCRIPT }, at - 60_000)[0],
  event: { request: { method: 'GET', url: `https://site.test${path}`, headers: {} }, response: { status: 200 } },
  logs: [{ level: 'log', timestamp: at - 60_000, message: [JSON.stringify({ event: 'http.response', elapsed_ms: ready, status: 200 })] }],
}) as unknown as TraceItem;

it('records response-ready time separately from background lifetime without double sampling logs', () => {
  const event = trace('/person/project');
  event.logs.push(event.logs[0]);
  const rows = httpTimings([event, trace('/phpmyadmin/phpinfo.php'), trace('/health')], FRONT_SCRIPT);
  expect(rows).toHaveLength(6);
  for (const row of rows) expect(row.hist.reduce((a,b) => a+b,0)).toBe(1);
  const page = rows.filter(r => r.traffic === 'page');
  expect(page[0].hist).not.toEqual(page[1].hist);
  expect(httpTimings([{ ...event, scriptName: 'another-worker' }], FRONT_SCRIPT)).toEqual([]);
  expect(httpTimings([{ ...event, outcome: 'exception' }], FRONT_SCRIPT)).toEqual([]);
});

it('does not count missing, negative or nonfinite response timings as fast answers', () => {
  for (const ready of [-1, Number.NaN]) {
    const rows = httpTimings([trace('/person/project', ready)], FRONT_SCRIPT);
    expect(rows.map(r => r.metric)).toEqual(['execution']);
  }
  expect(httpTimings([{ ...trace('/person/project'), logs: [] }], FRONT_SCRIPT).map(r => r.metric)).toEqual(['execution']);
});

async function seedBaseline(ledger: ReturnType<typeof deps>['ledger'], end: number) {
  await runInDurableObject(ledger, (_instance, state) => {
    const sql = state.storage.sql;
    // Independent closed windows across a day, not repeated polls of the same hour.
    for (let i=1;i<=24;i++) for (const metric of ['response','execution'])
      sql.exec('INSERT INTO latency_windows VALUES (?,?,?,?,?,?)', 'page', metric, end-i*60*60_000, 100, 100, 0);
  });
}
async function feedWindow(ledger: ReturnType<typeof deps>['ledger'], end: number, count: number, ms: number, path = '/person/project') {
  const event = trace(path, ms, ms);
  event.eventTimestamp = end - 60_000;
  await ledger.ingest([], end, [], httpTimings(Array.from({length:count}, () => event), FRONT_SCRIPT));
}

it('requires independent baseline history, enough traffic and two consecutive closed windows', async () => {
  const ledger = deps(testEnv(), {now:at}).ledger;
  await feedWindow(ledger, at, 100, 500);
  const first = await ledger.httpLatency(at);
  expect(first.every(s => s.status === 'learning' && !s.anomalous)).toBe(true);
  for(let i=0;i<10;i++) await ledger.httpLatency(at);
  expect((await ledger.httpLatency(at))[0].baseline_windows).toBe(0);
  await seedBaseline(ledger, at);
  expect((await ledger.httpLatency(at))[0]).toMatchObject({status:'ready',anomalous:false,baseline_windows:24});
  await feedWindow(ledger, at + LATENCY_WINDOW_MS, 100, 500);
  expect((await ledger.httpLatency(at+LATENCY_WINDOW_MS))[0]).toMatchObject({status:'ready',anomalous:true});
  await feedWindow(ledger, at + 2*LATENCY_WINDOW_MS, 1, 5000);
  expect((await ledger.httpLatency(at+2*LATENCY_WINDOW_MS))[0]).toMatchObject({status:'insufficient_traffic',anomalous:false});
});

it('scanner traffic does not train page latency and empty windows do not prove recovery', async () => {
  const e = testEnv({ RESPONSE_LATENCY:'on' });
  const ledger = deps(e,{now:at}).ledger;
  await seedBaseline(ledger, at);
  await feedWindow(ledger, at, 100, 500);
  await ledger.httpLatency(at);
  await feedWindow(ledger, at+LATENCY_WINDOW_MS, 100, 500);
  await watchHttp(e,ledger,at+LATENCY_WINDOW_MS,'abc123');
  expect((await ledger.findings('open',50)).map(f=>f.dedup_key)).toContain('front_worker:page_response_p95_ms');
  await feedWindow(ledger, at+2*LATENCY_WINDOW_MS, 1000, 10000, '/phpmyadmin/phpinfo.php');
  await watchHttp(e,ledger,at+2*LATENCY_WINDOW_MS,'abc123');
  expect((await ledger.findings('open',50)).map(f=>f.dedup_key)).toContain('front_worker:page_response_p95_ms');
  const state=(await ledger.httpLatency(at+2*LATENCY_WINDOW_MS))[0];
  expect(state.requests).toBe(0);
});

it('migrates from the preceding ledger schema without losing findings, and reapplies safely', async () => {
  const ledger=deps(testEnv(),{now:at}).ledger;
  await runInDurableObject(ledger,(_instance,state)=>{
    const sql=state.storage.sql;
    sql.exec('DROP TABLE http_latency_minutes');sql.exec('DROP TABLE latency_windows');
    sql.exec('UPDATE schema_version SET version=?',MIGRATIONS.length-1);
    sql.exec("INSERT INTO findings (dedup_key,component,kind,status,signals,summary,narrative_status,first_seen,last_seen) VALUES ('keep:test','source_repository','anomaly','open','[]','keep','pending',1,1)");
    expect(migrate(sql)).toBe(MIGRATIONS.length);
    expect(migrate(sql)).toBe(MIGRATIONS.length);
    expect(sql.exec('SELECT dedup_key FROM findings').one().dedup_key).toBe('keep:test');
  });
});

it('execution references require independent closed hours instead of three overlapping polls', async () => {
  const ledger=deps(testEnv(),{now:at}).ledger;
  const rows=aggregate(traces({component:'source_repository',count:100,wallMs:40},at-60_000),SCRIPT);
  await ledger.ingest(rows,at);
  for(let i=0;i<10;i++)await ledger.recordBaselines([],at+i*1000,true);
  const baselines=await ledger.baselines(true,at);
  expect(baselines['source_repository/p95_wall_ms'].windows).toBe(1);
  const snapshot={latencyCalibration:true,tail:{source_repository:{invocations:100,errors:0,exceptions:0,errorLogs:0,p95WallMs:1000}}} as unknown as Snapshot;
  expect(invocationSignals('source_repository',snapshot,baselines).find(s=>s.name==='p95_execution_ms')?.anomalous).toBe(false);
  expect(invocationSignals('source_repository',snapshot,{
    'source_repository/p95_wall_ms':{value:100,samples:25,windows:25,spanMs:24*3_600_000,ceiling:150},
  }).find(s=>s.name==='p95_execution_ms')?.anomalous).toBe(true);
});

it('status reads do not manufacture calibration windows',async()=>{
  const ledger=deps(testEnv(),{now:at}).ledger;
  await feedWindow(ledger,at,100,40);
  for(let i=0;i<10;i++)await ledger.httpStatus(at);
  await runInDurableObject(ledger,(_instance,state)=>{
    expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM latency_windows').one().n).toBe(0);
  });
});

it('keeps a calibrated execution warning separate from an actual failure',()=>{
  const snapshot={latencyCalibration:true,tail:{source_repository:{invocations:100,errors:10,exceptions:0,errorLogs:0,p95WallMs:1000}}} as unknown as Snapshot;
  const signals=invocationSignals('source_repository',snapshot,{
    'source_repository/p95_wall_ms':{value:100,samples:25,windows:25,spanMs:24*3_600_000,ceiling:150},
  });
  expect(problems({component:'source_repository',watched:true,anomalous:true,samples:[],signals}).map(p=>p.key).sort()).toEqual([
    'source_repository:error_rate','source_repository:p95_execution_ms',
  ]);
});
