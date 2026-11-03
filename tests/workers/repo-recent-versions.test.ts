import { expect, it } from 'vitest';
import { api, author, countingOps, file, scoped, signup, usePlatformFixture } from './repo-fixture';
import type { Env } from '../../cloudflare/worker/types';

usePlatformFixture();
const on={...scoped,RECENT_VERSIONS:'on'} as Env;
async function setup(name:string,grow=false,visibility='private') {
 const owner={cookie:await signup(name)};
 const r=await api('/repos',owner,{body:{name:'versions',visibility,files:[file('README.md','# Versions\n')],author,policy:{approvals:0,required_checks:[]}}},on);
 expect(r.status).toBe(200);
 const id=r.body.id,root=r.body.commit;
 if(grow){
  const c=await api(`/repos/${id}/commits`,owner,{body:{ref:'main',changes:[file('next.txt','next\n')],message:'next',author}},on);
  expect(c.status).toBe(200);
  const old=new Map<number,string>();
  for(let left=502;left>0;left-=100){
   const updates=Array.from({length:Math.min(100,left)},(_,i)=>{const next=old.get(i)===root?c.body.commit:root;const update={ref:`branch${i}`,commit:next,expected:old.get(i)??null};old.set(i,next);return update;});
   expect((await api(`/repos/${id}/refs/batch`,owner,{body:{updates}},on)).status).toBe(200);
  }
 }
 return {owner,id};
}
it('advertises enabled reads and returns newest compact choices beyond500 with bounded older pages',async()=>{
 const r=await setup('recent_versions',true);
 const status=await api(`/repos/${r.id}?summary=true`,r.owner,{},on);
 expect(status.body.recent_versions).toBe(true);expect(status.body.version).toBe(503);
 const seen=countingOps(on);
 const first=await api(`/repos/${r.id}/versions?compact=true&limit=50`,r.owner,{},seen.env);
 expect(first.status).toBe(200);expect(first.body.format).toBe('recent-versions-v1');
 expect(first.body.entries.map((e:any)=>e.version)).toEqual(Array.from({length:50},(_,i)=>503-i));
 expect(Object.keys(first.body.entries[0]).sort()).toEqual(['committed_at_ms','kind','version']);
 expect(JSON.stringify(first.body).length).toBeLessThan(8192);
 expect(seen.take()).toMatchObject({repo_txlog:1});
 const q=new URLSearchParams({through:'503',before:String(first.body.next_before),history_chain:first.body.history_chain});
 const next=await api(`/repos/${r.id}/versions?${q}`,r.owner,{},on);
 expect(next.body.entries[0].version).toBe(453);expect(next.body.entries[49].version).toBe(404);
 const legacy=await api(`/repos/${r.id}/txlog?after=500&limit=3`,r.owner,{},on);
 expect(legacy.body.entries.map((e:any)=>e.version)).toEqual([501,502,503]);
});
it('disabled/old capability responses stay explicit rather than pretending to return a recent page',async()=>{
 const r=await setup('versions_disabled');const off={...on,RECENT_VERSIONS:'off'};
 expect((await api(`/repos/${r.id}?summary=true`,r.owner,{},off)).body.recent_versions).toBeUndefined();
 const page=await api(`/repos/${r.id}/versions?compact=true`,r.owner,{},off);
 expect(page.status).toBe(400);expect(page.body.error.code).toBe('NOT_SUPPORTED');
});
it('fresh admission applies to private, removed-token and public responses',async()=>{
 const r=await setup('versions_access');
 expect((await api(`/repos/${r.id}/versions`,{}, {},on)).status).toBe(404);
 const t=await api(`/repos/${r.id}/tokens`,r.owner,{body:{name:'reader',scopes:['read'],paths:['README.md']}},on);
 const reader={token:t.body.token};
 const visible=await api(`/repos/${r.id}/versions`,reader,{},on);
 expect(visible.status).toBe(200);
 expect(visible.body.entries.every((e:any)=>e.paths.every((p:any)=>p.path==='README.md'))).toBe(true);
 expect(visible.body.entries[0].read_set).toBeUndefined();
 expect((await api(`/repos/${r.id}/tokens/reader`,r.owner,{method:'DELETE'},on)).status).toBe(200);
 expect((await api(`/repos/${r.id}/versions`,reader,{},on)).status).toBe(401);
 const pub=await setup('versions_public',false,'public');
 expect((await api(`/repos/${pub.id}/versions`,{}, {},on)).status).toBe(200);
});
it('rejects malformed bounds and a changed cursor without falling back to an old page',async()=>{
 const r=await setup('versions_bounds');
 for(const query of ['before=oops','limit=-1','before=0','before=1','through=999']){
  const page=await api(`/repos/${r.id}/versions?${query}`,r.owner,{},on);
  expect(page.status).toBeGreaterThanOrEqual(400);
 }
 const first=await api(`/repos/${r.id}/versions`,r.owner,{},on);
 const page=await api(`/repos/${r.id}/versions?through=1&before=1&history_chain=replaced`,r.owner,{},on);
 expect(page.status).toBe(409);expect(page.body.error.code).toBe('ACTIVITY_CHANGED');
 expect(first.body.entries[0].version).toBe(1);
});
