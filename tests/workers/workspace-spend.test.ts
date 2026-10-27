import { expect, it } from 'vitest';
import type { Json } from '../../cloudflare/worker/types';
import { validateWorkspaceSpendRun } from '../../cloudflare/worker/workspace-spend';

it('requires pricing for every distinct pool group', () => {
  const budget={provider:'codex',model:'gpt-5.6-luna',pricing:{input_microusd_per_million:250000,output_microusd_per_million:1200000,source:'conservative'}};
  const run:Json={workspace_spend:{version:1},model_budgets:[budget]};
  expect(()=>validateWorkspaceSpendRun(run)).not.toThrow();
  for(const budgets of [[],[{...budget,pricing:null}],[budget,budget]])
    expect(()=>validateWorkspaceSpendRun({...run,model_budgets:budgets})).toThrowError(expect.objectContaining({code:'WORKSPACE_SPEND_SCOPE'}));
});
