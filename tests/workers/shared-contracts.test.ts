// Drift guard for the generated shared contracts (shared/contracts, `cargo xtask contracts`):
// the live `GET /repos/:id` answer has exactly the generated RepoStatus fields, with the
// generated required ones present, and shared/account.ts reads its limits from the schema.
import { expect, it } from 'vitest';
import {
  ACCOUNT_IDENTIFIER_HELP,
  MAX_ACCOUNT_IDENTIFIER_LENGTH,
  normalizeAccountIdentifier,
} from '../../shared/account';
import { accountSchema } from '../../shared/contracts/account';
import { repoStatusSchema } from '../../shared/contracts/repo-status';
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
