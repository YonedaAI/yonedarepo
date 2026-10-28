// The LFS quota setting: GiB text to bytes (refusing nonsense and anything over the
// platform's largest quota), byte formatting, the share used, and the section's loading,
// error and loaded states, reached from the Settings navigation.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loaded } from '../source-platform/useSource';

const state: { value: Loaded<any> } = { value: { loading: true, reload: () => {} } };
vi.mock('../source-platform/useSource', () => ({ useSource: () => state.value }));

const { formatBytes, GIB, parseQuota, quotaText, usedPercent } = await import('./lfsQuota');
const { LfsSettings } = await import('./LfsSettings');
const { RepoSettings } = await import('./RepoSettings');

const repo = 'r0123456789abcdef0123';
const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const usage = {
  quota_bytes: 5 * GIB,
  used_bytes: 300 * 1024 ** 2,
  stored_bytes: 200 * 1024 ** 2,
  pending_bytes: 100 * 1024 ** 2,
  objects: 1,
  max_object_bytes: 5_000_000_000,
  max_quota_bytes: 1024 * GIB,
};

beforeEach(() => {
  state.value = { loading: true, reload: () => {} };
});

describe('quota values', () => {
  it('reads GiB text as whole bytes and refuses what cannot be a quota', () => {
    expect(parseQuota('5', usage.max_quota_bytes)).toEqual({ bytes: 5 * GIB });
    expect(parseQuota(' 0.5 ', usage.max_quota_bytes)).toEqual({ bytes: GIB / 2 });
    expect(parseQuota('0', usage.max_quota_bytes)).toEqual({ bytes: 0 });
    for (const bad of ['', '-1', 'five', '1e3', '2 GiB'])
      expect(parseQuota(bad, usage.max_quota_bytes)).toHaveProperty('error');
    expect(parseQuota('1025', usage.max_quota_bytes)).toEqual({
      error: 'The largest quota is 1 TiB',
    });
    expect(quotaText(5 * GIB)).toBe('5');
    expect(quotaText(GIB / 3)).toBe('0.333');
  });
  it('formats bytes and the share used', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(200 * 1024 ** 2)).toBe('200 MiB');
    expect(formatBytes(1.5 * GIB)).toBe('1.5 GiB');
    expect(formatBytes(5_000_000_000)).toBe('4.7 GiB');
    expect(usedPercent(usage)).toBe(6);
    expect(usedPercent({ quota_bytes: 0, used_bytes: 0 })).toBe(0);
    expect(usedPercent({ quota_bytes: 0, used_bytes: 1 })).toBe(100);
    expect(usedPercent({ quota_bytes: 10, used_bytes: 50 })).toBe(100);
  });
});

describe('LFS section', () => {
  it('shows loading, then a failure with retry', () => {
    expect(html(LfsSettings, { repo })).toContain('Loading LFS usage');
    state.value = { loading: false, error: 'FORBIDDEN', reload: () => {} };
    const failed = html(LfsSettings, { repo });
    expect(failed).toContain('FORBIDDEN');
    expect(failed).not.toContain('Save quota');
  });
  it('shows usage, reservations and the quota form', () => {
    state.value = { loading: false, data: usage, reload: () => {} };
    const page = html(LfsSettings, { repo });
    expect(page).toContain('200 MiB in 1 object');
    expect(page).toContain('Reserved by uploads in progress');
    expect(page).toContain('5 GiB (6% used)');
    expect(page).toContain('value="5"');
    expect(page).toContain('Save quota');
    state.value = {
      loading: false,
      data: { ...usage, pending_bytes: 0, objects: 2 },
      reload: () => {},
    };
    const idle = html(LfsSettings, { repo });
    expect(idle).not.toContain('Reserved by uploads');
    expect(idle).toContain('in 2 objects');
  });
  it('is a Settings section', () => {
    const props = {
      repo,
      status: {
        name: 'demo',
        version: 1,
        policy: { required_checks: [], approvals: 0 },
        viewer: { owner: true, role: null },
      },
      navigate: () => {},
      onPolicySaved: () => {},
      onDeleted: () => {},
    };
    state.value = { loading: false, data: usage, reload: () => {} };
    const page = html(RepoSettings, { ...props, section: 'lfs' });
    expect(page).toContain(`href="/source/${repo}/settings/lfs"`);
    expect(page).toContain('Large files (LFS)</h2>');
  });
});
