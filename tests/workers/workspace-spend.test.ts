import { env } from 'cloudflare:workers';
import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import type { Env, Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { startCampaignTrial } from '../../cloudflare/worker/reviewer-campaign-trial';
import { reserveWorkspaceSpend, settleWorkspaceSpend, validateWorkspaceSpendRun,
  workspaceSpendConfigure, workspaceSpendRun, workspaceSpendStatus } from '../../cloudflare/worker/workspace-spend';
import { signup } from './reviewer-fixture';

const bindings = env as unknown as Env;
afterEach(async () => { await reset(); });
it('reads a pure default, atomically shares an allowance and retains counts/spend across eviction and replay', async () => {
  const owner = 'ordinary_allowance'; await signup(owner);
  expect(await workspaceSpendStatus(bindings, owner)).toEqual({version:0,limit_microusd:50000000,
    charged_microusd:0,reserved_microusd:0,remaining_microusd:50000000});
  expect((await workspaceSpendConfigure(bindings,owner,0,1000)).version).toBe(1);
  const group={provider:'codex',model:'gpt-5.6-luna',pricing:{source:'synthetic'}};
  const context={owner,repo_id:'ordinary',run_id:'run',job_id:'job:run:agent',epoch:1,provider:group.provider,model:group.model,model_budget:group};
  const counted={number:1,reservation_id:'model-request:one',reservation_microusd:700,
    model_budget:{provider:context.provider,model:context.model,pricing:{source:'synthetic'}}};
  const first=await reserveWorkspaceSpend(bindings,context,'first',counted);
  await reserveWorkspaceSpend(bindings,context,'first',counted);
  await expect(reserveWorkspaceSpend(bindings,{...context,run_id:'other'},'first',counted)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(reserveWorkspaceSpend(bindings,context,'second',{...counted,number:2,reservation_microusd:301})).rejects.toMatchObject({code:'WORKSPACE_SPEND_EXHAUSTED'});
  await evictDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`account:${owner}`)));
  expect((await workspaceSpendStatus(bindings,owner)).reserved_microusd).toBe(700);
  await settleWorkspaceSpend(bindings,owner,first,100,{input_tokens:10,output_tokens:5});
  await settleWorkspaceSpend(bindings,owner,first,100,{input_tokens:10,output_tokens:5});
  expect(await workspaceSpendStatus(bindings,owner)).toEqual({version:1,limit_microusd:1000,
    charged_microusd:100,reserved_microusd:0,remaining_microusd:900});
  await expect(workspaceSpendConfigure(bindings,owner,0,50000000)).rejects.toMatchObject({code:'STALE_VERSION'});
  await expect(workspaceSpendConfigure(bindings,owner,1,99)).rejects.toMatchObject({code:'WORKSPACE_SPEND_LIMIT'});
});
it('requires server run markers and pricing for every distinct pool group', () => {
  expect(workspaceSpendRun({adaptive_team:{version:1}})).toBe(true);
  expect(workspaceSpendRun({workspace_spend:{version:1}})).toBe(true);
  expect(workspaceSpendRun({})).toBe(false);
  const budget={provider:'codex',model:'gpt-5.6-luna',pricing:{input_microusd_per_million:250000,output_microusd_per_million:1200000,source:'conservative'}};
  const run:Json={workspace_spend:{version:1},model_budgets:[budget]};
  expect(()=>validateWorkspaceSpendRun(run)).not.toThrow();
  for(const budgets of [[],[{...budget,pricing:null}],[budget,budget]])
    expect(()=>validateWorkspaceSpendRun({...run,model_budgets:budgets})).toThrowError(expect.objectContaining({code:'WORKSPACE_SPEND_SCOPE'}));
  expect(()=>validateWorkspaceSpendRun({...run,campaign:{id:'old'}})).toThrow('legacy');
});
it('observes legacy workspace reservations once without changing their counters or limit', async () => {
  const owner='retained_allowance';await signup(owner);
  await workspace(bindings,owner,{op:'budget_reserve',id:'old',amount:1234});
  const before=await workspace(bindings,owner,{op:'budget_status'});
  expect((await workspaceSpendStatus(bindings,owner)).reserved_microusd).toBe(1234);
  await workspaceSpendConfigure(bindings,owner,0,50000000);
  expect(await workspace(bindings,owner,{op:'budget_status'})).toEqual(before);
  await workspace(bindings,owner,{op:'budget_settle',id:'old',amount:20});
  expect(await workspaceSpendStatus(bindings,owner)).toMatchObject({charged_microusd:20,reserved_microusd:0});
});
it('serializes competing provider groups against one allowance rather than one cap per model', async () => {
  const owner='parallel_allowance';await signup(owner);
  await workspaceSpendConfigure(bindings,owner,0,1000);
  const group={provider:'codex',model:'gpt-5.6-luna',pricing:{source:'synthetic'}};
  const context={owner,repo_id:'ordinary',run_id:'run',job_id:'job:run:agent',epoch:1,provider:group.provider,model:group.model,model_budget:group};
  const other={...context,provider:'claude',model:'claude-sonnet-5-5',job_id:'job:run:other',model_budget:{...group,provider:'claude',model:'claude-sonnet-5-5'}};
  const counted=(c:typeof context,id:string)=>({number:1,reservation_id:id,reservation_microusd:700,
    model_budget:{provider:c.provider,model:c.model,pricing:{source:'synthetic'}}});
  const results=await Promise.allSettled([reserveWorkspaceSpend(bindings,context,'parallel-one',counted(context,'one')),
    reserveWorkspaceSpend(bindings,other,'parallel-two',counted(other,'two'))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'WORKSPACE_SPEND_EXHAUSTED'}});
  expect(await workspaceSpendStatus(bindings,owner)).toMatchObject({reserved_microusd:700,remaining_microusd:300});
});
it('denies legacy campaign trial creation before any historical campaign allocation after transition', async () => {
  const owner='transitioned_campaign';await signup(owner);
  const status=await workspaceSpendConfigure(bindings,owner,0,50000000);
  await expect(startCampaignTrial(bindings,owner,'forbidden-new-trial'))
    .rejects.toMatchObject({code:'WORKSPACE_LEGACY_INFERENCE_BLOCKED'});
  expect(await workspaceSpendStatus(bindings,owner)).toEqual(status);
  await expect(workspace(bindings,owner,{op:'campaign_status',id:'reviewer-event-booking-20261012-v1'}))
    .rejects.toMatchObject({code:'NOT_FOUND'});
});
