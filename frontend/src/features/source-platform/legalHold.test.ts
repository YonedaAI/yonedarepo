// Legal holds as people read them: who set one, when an organization counts as held, and
// that a control an owner cannot use is not offered.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { heldBy, OrgHoldSection, OrgRepoHold, orgHeld } from './LegalHold';
import { DeleteOrganization } from './OrgDelete';

const layer = { at: 1_700_000_000_000, by: 'user:alice' };
const noop = () => {};
const section = (hold: Parameters<typeof heldBy>[0] | null, manages = true) =>
  renderToStaticMarkup(
    createElement(OrgHoldSection, {
      org: 'acme',
      holds: { org: hold, repos: {} },
      manages,
      onChanged: noop,
    }),
  );
const repoRow = (hold?: Parameters<typeof heldBy>[0], manages = true) =>
  renderToStaticMarkup(
    createElement(OrgRepoHold, {
      org: 'acme',
      repo: 'r0123456789abcdef0123',
      name: 'app',
      hold,
      manages,
      onChanged: noop,
    }),
  );

describe('who set a hold', () => {
  it('names the owner, and says when only an operator can release it', () => {
    expect(heldBy({ owner: layer })).toContain('Set by alice');
    expect(heldBy({ operator: { ...layer, by: 'ops' } })).toContain('Only an operator can release');
    expect(heldBy({ operator: { ...layer, by: 'ops' } })).not.toContain('ops');
    expect(heldBy({ owner: layer, operator: layer })).toContain('an owner and an operator');
  });
});

describe('an organization on hold', () => {
  it('counts a hold on it or on any of its repositories', () => {
    expect(orgHeld(undefined)).toBe(false);
    expect(orgHeld({ org: null, repos: {} })).toBe(false);
    expect(orgHeld({ org: { owner: layer }, repos: {} })).toBe(true);
    expect(orgHeld({ org: null, repos: { r1: { owner: layer } } })).toBe(true);
  });

  it('offers owners a place or a release, and members neither', () => {
    expect(section(null)).toContain('Place legal hold');
    expect(section({ owner: layer })).toContain('Release legal hold');
    expect(section({ owner: layer })).toContain('role="status"');
    expect(section(null, false)).not.toContain('<button');
    expect(section({ owner: layer }, false)).not.toContain('<button');
  });

  it('offers owners nothing to release of an operator hold', () => {
    const page = section({ operator: layer });
    expect(page).toContain('Only an operator can release');
    expect(page).not.toContain('<button');
  });

  it('shows a held repository in the list, and only owners its control', () => {
    expect(repoRow({ owner: layer })).toContain('On hold');
    expect(repoRow({ owner: layer })).toContain('Release legal hold');
    expect(repoRow(undefined)).not.toContain('On hold');
    expect(repoRow(undefined)).toContain('Place legal hold');
    expect(repoRow({ owner: layer }, false)).not.toContain('<button');
  });

  it('turns deleting the organization off while held, and says why', () => {
    const page = (held: boolean) =>
      renderToStaticMarkup(
        createElement(DeleteOrganization, { org: 'acme', held, onDeleted: noop }),
      );
    expect(page(true)).toContain('Under a legal hold');
    expect(page(true)).toMatch(/<input[^>]*disabled/);
    expect(page(false)).not.toContain('Under a legal hold');
    expect(page(false)).not.toMatch(/<input[^>]*disabled/);
  });
});
