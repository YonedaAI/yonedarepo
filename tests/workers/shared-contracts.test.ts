// Drift guard for the generated shared contracts (shared/contracts, `cargo xtask contracts`):
// the live `GET /repos/:id` answer has exactly the generated RepoStatus fields, with the
// generated required ones present, shared/account.ts reads its limits from the schema, and
// a policy the editor builds from the generated Policy (every catalog value) is accepted.
import { expect, it } from 'vitest';
import {
  ACCOUNT_IDENTIFIER_HELP,
  MAX_ACCOUNT_IDENTIFIER_LENGTH,
  normalizeAccountIdentifier,
} from '../../shared/account';
import { accountSchema } from '../../shared/contracts/account';
import { policySchema } from '../../shared/contracts/policy';
import { repoStatusSchema } from '../../shared/contracts/repo-status';
import {
  AUTO_APPROVABLE,
  CHECK_NAME,
  DEFAULT_TIMEOUT_SECONDS,
  type Policy,
  parseArgv,
  REVIEW_MODELS,
  SECRET_RULES,
} from '../../frontend/src/features/repo-settings/policy';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

it('answers GET /repos/:id with exactly the generated RepoStatus fields', async () => {
  const owner = { cookie: await signup('contracts') };
  const created = await api(
    '/repos',
    owner,
    { body: { name: 'contracts', files: [file('a.txt', 'a\n')], author } },
  );
  const status = (await api(`/repos/${created.body.id}`, owner, {})).body;
  const fields = Object.keys(repoStatusSchema.properties).sort();
  expect(Object.keys(status).sort()).toEqual(fields);
  for (const field of repoStatusSchema.required) expect(status[field]).not.toBeUndefined();
  const viewer = repoStatusSchema.$defs.Viewer.properties;
  expect(Object.keys(status.viewer).sort()).toEqual(Object.keys(viewer).sort());
  const ref = repoStatusSchema.$defs.RefHead.properties;
  expect(Object.keys(status.refs[0]).sort()).toEqual(Object.keys(ref).sort());
});

it('takes the account identifier limits from the generated contract', () => {
  expect(MAX_ACCOUNT_IDENTIFIER_LENGTH).toBe(accountSchema.maxLength);
  expect(ACCOUNT_IDENTIFIER_HELP).toBe(accountSchema.description);
  expect(normalizeAccountIdentifier(`${'a'.repeat(250)}@x.io`)).toBeNull();
});

it('accepts a policy built from the generated Policy and its constants, as the editor sends it', async () => {
  const owner = { cookie: await signup('policies') };
  const created = await api('/repos', owner, { body: { name: 'policies', files: [file('a.txt', 'a\n')], author } });
  const repo = `/repos/${created.body.id}`;
  // Every field and every catalog value the editor offers.
  const policy: Policy = {
    required_checks: ['unit', 'review.v2', 'posted_by-hand'],
    approvals: 1,
    auto_approve: AUTO_APPROVABLE.map((c) => c.id),
    runners: {
      unit: { command: parseArgv('cargo test'), timeout_seconds: DEFAULT_TIMEOUT_SECONDS },
      'review.v2': { kind: 'model', rubric: 'Fail on unchecked input.', model: REVIEW_MODELS[0] },
    },
    check_posters: { 'posted_by-hand': ['owner'] },
    secret_allow: SECRET_RULES.map((rule) => ({ path: 'fixtures/', rule })),
  };
  const saved = await api(`${repo}/policy`, owner, { method: 'PUT', body: { policy } });
  expect(saved.status).toBe(200);
  const status = (await api(repo, owner, {})).body;
  expect(Object.keys(status.policy).sort()).toEqual(Object.keys(policySchema.properties).sort());
  // The check-name pattern the editor enforces is the one the server applies.
  const pattern = new RegExp(`^(?:${CHECK_NAME})$`, 'v');
  for (const name of ['a', '0-x', 'a'.repeat(64), 'A', '-a', 'a b', 'a'.repeat(65), 'é']) {
    const answer = await api(`${repo}/policy`, owner, {
      method: 'PUT',
      body: { policy: { required_checks: [name], approvals: 0 } },
    });
    expect(answer.status === 200, name).toBe(pattern.test(name));
  }
});
