import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; init?: { method?: string } }[] = [];
let answers: Record<string, unknown>;
vi.mock('./sourceApi', () => ({
  sourceApi: async (path: string, init?: { method?: string }) => {
    calls.push({ path, init });
    const answer = answers[init?.method ?? 'GET'];
    if (answer instanceof Error) throw answer;
    return answer;
  },
}));

const { revokedNote, revokePat, revokePrompt } = await import('./tokenRevoke');

const pat = (ssh_keys?: number) => ({
  id: 'pat_0123456789abcdef',
  name: 'laptop',
  scopes: ['repo:read'],
  repos: null,
  created_at: 1,
  expires_at: null,
  last_used_at: null,
  ssh_keys,
});
const reload = vi.fn();
const loaded = { loading: false, reload };
const confirm = vi.fn();

beforeEach(() => {
  calls.length = 0;
  answers = {};
  reload.mockClear();
  confirm.mockReset();
  vi.stubGlobal('window', { confirm });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the revocation confirmation', () => {
  it('says how many SSH keys go', () => {
    expect(revokePrompt({ name: 'laptop' }, 'Clients using it', 1)).toBe(
      'Revoke laptop? Clients using it stop working immediately. This also removes the 1 SSH key it added, so Git over SSH with that key stops too.',
    );
    expect(revokePrompt({ name: 'laptop' }, 'That CLI and its agents', 2)).toContain(
      'That CLI and its agents stop working immediately. This also removes the 2 SSH keys it added, so Git over SSH with those keys stops too.',
    );
    expect(revokePrompt({ name: 'ci' }, 'Clients using it', 0)).toBe(
      'Revoke ci? Clients using it stop working immediately. No SSH keys are removed.',
    );
  });

  it('asks with the count as of now, not as the page loaded', async () => {
    answers = { GET: { tokens: [pat(2)] }, DELETE: { removed_ssh_keys: [{}, {}] } };
    confirm.mockReturnValue(true);
    const note = await revokePat(pat(0), loaded);
    expect(confirm.mock.calls[0][0]).toContain('removes the 2 SSH keys');
    expect(note).toBe('Revoked laptop and removed the 2 SSH keys it added.');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('still asks and revokes when the fresh count cannot be read', async () => {
    answers = { GET: new Error('offline'), DELETE: { removed_ssh_keys: [{}] } };
    confirm.mockReturnValue(true);
    expect(await revokePat(pat(1), loaded)).toBe(
      'Revoked laptop and removed the 1 SSH key it added.',
    );
    expect(confirm.mock.calls[0][0]).toContain('removes the 1 SSH key it added');
  });

  it('does nothing when cancelled', async () => {
    answers = { GET: { tokens: [pat(1)] } };
    confirm.mockReturnValue(false);
    expect(await revokePat(pat(1), loaded)).toBeNull();
    expect(calls.map((c) => c.init?.method ?? 'GET')).toEqual(['GET']);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reports what the server removed, which may differ from what was shown', () => {
    expect(revokedNote({ name: 'ci' }, 0)).toBe('Revoked ci. No SSH keys were removed.');
  });
});
