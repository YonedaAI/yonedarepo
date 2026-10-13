import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { hostedMcp } from '../../cloudflare/worker/hosted-mcp';
import type { Scope } from '../../cloudflare/worker/types';
import { bindings, readyReview, repo } from './comparison-review-fixture';

afterEach(reset);

it('delivers bounded attached R2 evidence bytes through the actual comparison manifest authority', async () => {
  const { job, context } = await readyReview();
  const digest = context.manifest.alternatives[0].evidence_refs.find((ref: string) => /^[a-f0-9]{64}$/.test(ref));
  expect(digest).toBeDefined();
  const scope = { repo_id: repo, job } as Scope;
  const response = await hostedMcp(bindings, scope, { name: 'comparison_context', arguments: {
    digest, offset: 0, limit: 4,
  } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ digest,
    manifest_digest: context.manifest_digest, content: 'Synt', truncated: true, next_offset: 4 });
});
