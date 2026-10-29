// Repository Settings: policy editing keeps every field the server sent, webhooks and their
// deliveries in each state, and the tab's owner gate and sections.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loaded } from '../source-platform/useSource';

const state: { value: Loaded<any> } = { value: { loading: true, reload: () => {} } };
vi.mock('../source-platform/useSource', () => ({ useSource: () => state.value }));

const policy = await import('./policy');
const { DeliveryTable, HookTable } = await import('./HookParts');
const { RepoSettings } = await import('./RepoSettings');
const { PolicyForm } = await import('./PolicyForm');
const { ChecksSettings } = await import('./ChecksSettings');
const { RunnerEditor } = await import('./RunnerEditor');

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const loaded = (value: Partial<Loaded<any>>): Loaded<any> => ({
  loading: false,
  reload: () => {},
  ...value,
});
const repo = 'r0123456789abcdef0123';
const base = {
  required_checks: ['ci', 'review'],
  approvals: 1,
  runners: { review: { kind: 'model' as const, rubric: 'No secrets' } },
  check_posters: { ci: ['owner', 'token:ci'] },
  future_field: { kept: true },
};

beforeEach(() => {
  state.value = { loading: true, reload: () => {} };
});

describe('policy editing', () => {
  it('offers the review catalog and secret rules the Rust policy contract lists', () => {
    const editor = html(RunnerEditor, {
      name: 'review',
      runner: { kind: 'model', rubric: 'No secrets' },
      required: true,
      onChange: () => {},
      onRequired: () => {},
      onRemove: () => {},
    });
    for (const model of policy.REVIEW_MODELS)
      expect(editor).toContain(`<option value="${model}" selected="">${model}</option>`);
    expect(policy.SECRET_RULES).toContain('yonedarepo-pat');
    expect(policy.AUTO_APPROVABLE.map((c) => c.label)).toEqual([
      'Documentation only',
      'Formatting only',
      'Comments only',
    ]);
    expect(policy.DEFAULT_TIMEOUT_SECONDS).toBe(600);
    expect(new RegExp(`^${policy.CHECK_NAME}$`).test('unit.v2')).toBe(true);
  });
  it('changes only what it knows and keeps unknown fields for the round trip', () => {
    const next = policy.withRunner(base, 'tests', { command: ['cargo', 'test'] });
    expect(next.future_field).toEqual({ kept: true });
    expect(Object.keys(next.runners ?? {})).toEqual(['review', 'tests']);
    const removed = policy.withRunner(policy.withRunner(next, 'review', null), 'tests', null);
    expect('runners' in removed).toBe(false);
  });
  it('drops posters with the requirement they bind', () => {
    expect(policy.withRequired(base, 'ci', false)).not.toHaveProperty('check_posters');
    expect(policy.withRequiredChecks(base, ['review']).check_posters).toBeUndefined();
    expect(policy.withRequiredChecks(base, ['ci']).check_posters).toEqual(base.check_posters);
    expect(policy.withRequired(base, 'ci', true)).toBe(base);
    expect(policy.postedChecks(base)).toEqual(['ci']);
  });
  it('reads commands and lists as typed', () => {
    expect(policy.parseArgv('cargo  test --all')).toEqual(['cargo', 'test', '--all']);
    expect(policy.parseArgv('["sh", "-c", "npm ci && npm test"]')).toEqual([
      'sh',
      '-c',
      'npm ci && npm test',
    ]);
    expect(() => policy.parseArgv('[1, 2]')).toThrow(/JSON array of strings/);
    expect(policy.argvText(['cargo', 'test'])).toBe('cargo test');
    expect(policy.argvText(['sh', '-c', 'a && b'])).toBe('["sh","-c","a && b"]');
    expect(policy.listFromText('a, b\n\nc\na')).toEqual(['a', 'b', 'c']);
  });
});

describe('policy forms', () => {
  it('disables Save until the draft changes and lists checks with their kinds', () => {
    const form = html(PolicyForm, {
      repo,
      policy: base,
      label: 'checks',
      onSaved: () => {},
      children: (draft: any, change: any) => createElement(ChecksSettings, { draft, change }),
    });
    expect(form).toMatch(/<button type="submit" disabled="">Save checks<\/button>/);
    expect(form).toContain('AI check <code>review</code>');
    expect(form).toContain('Posters of <code>ci</code>');
    expect(form).toContain('value="owner, token:ci"');
  });
});

describe('webhooks', () => {
  const hook = {
    id: 3,
    url: 'https://ci.example.com/h',
    events: ['land'],
    paths: null,
    active: true,
    pending: 2,
    created_at: 1,
  };
  const handlers = { onDeliveries: () => {}, onDelete: () => {} };
  it('shows loading, failure, empty and populated hooks', () => {
    expect(html(HookTable, { ...handlers, hooks: loaded({ loading: true }) })).toContain(
      'Loading webhooks',
    );
    expect(html(HookTable, { ...handlers, hooks: loaded({ error: 'boom' }) })).toContain('Retry');
    expect(html(HookTable, { ...handlers, hooks: loaded({ data: { hooks: [] } }) })).toContain(
      'No webhooks',
    );
    const table = html(HookTable, {
      ...handlers,
      hooks: loaded({
        data: { hooks: [hook, { ...hook, id: 4, events: null, active: false, failures: 9 }] },
      }),
    });
    expect(table).toContain('active · 2 queued');
    expect(table).toContain('land, merged, refused, branch, tag, check');
    expect(table).toContain('after 9 failures');
    expect(table).not.toContain('secret');
  });
  it('shows deliveries newest first with their result', () => {
    const deliveries = loaded({
      data: {
        deliveries: [
          {
            delivery_id: 'd1',
            event: 'land',
            attempt: 2,
            ok: true,
            status: 200,
            ms: 40,
            error: null,
            at: 1,
          },
          {
            delivery_id: 'd1',
            event: 'land',
            attempt: 1,
            ok: false,
            status: 503,
            ms: 9,
            error: null,
            at: 0,
          },
        ],
      },
    });
    const table = html(DeliveryTable, { deliveries });
    expect(table).toContain('delivered (200)');
    expect(table).toContain('failed: HTTP 503');
    expect(html(DeliveryTable, { deliveries: loaded({ data: { deliveries: [] } }) })).toContain(
      'Nothing delivered yet',
    );
  });
});

describe('settings tab', () => {
  const status = {
    name: 'demo',
    version: 3,
    policy: base,
    viewer: { owner: true, role: null },
  };
  const props = {
    repo,
    status,
    navigate: () => {},
    onPolicySaved: () => {},
    onDeleted: () => {},
  };
  it('is the owner and admins only', () => {
    expect(html(RepoSettings, { ...props, section: 'rules', status: undefined })).toContain(
      'Loading settings',
    );
    const member = { ...status, viewer: { owner: false, role: 'write' } };
    expect(html(RepoSettings, { ...props, section: 'rules', status: member })).toContain(
      'Only the owner and admins',
    );
  });
  it('links every section and shows the one addressed', () => {
    const rules = html(RepoSettings, { ...props, section: 'rules' });
    for (const label of ['Landing rules', 'Checks', 'Secret exceptions', 'Webhooks', 'Members'])
      expect(rules).toContain(`>${label}</a>`);
    expect(rules).toContain(`href="/source/${repo}/settings/webhooks"`);
    expect(rules).toContain('Approvals needed to land on main');
    expect(rules).toContain('Documentation only');
    const secrets = html(RepoSettings, { ...props, section: 'secrets' });
    expect(secrets).toContain('No exceptions');
    expect(secrets).toContain('<option value="github-pat">');
    const danger = html(RepoSettings, { ...props, section: 'delete' });
    expect(danger).toContain('<strong>demo</strong>');
    expect(danger).not.toContain('agent project');
  });
});
