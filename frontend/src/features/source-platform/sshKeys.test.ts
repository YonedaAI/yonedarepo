import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SshKeyTable, SshSetup } from './SshKeys';
import { publicKeyProblem, type SshKey, suggestedTitle } from './sshKeyModel';
import type { Loaded } from './useSource';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const reload = () => {};
const table = (keys: Loaded<{ keys: SshKey[] }>) =>
  renderToStaticMarkup(createElement(SshKeyTable, { keys, onDelete: () => {} }));

describe('SSH key paste checks', () => {
  it('accepts one public key line, with or without a comment', () => {
    expect(publicKeyProblem(KEY)).toBe('');
    expect(publicKeyProblem(`${KEY} alice@laptop\n`)).toBe('');
    expect(publicKeyProblem('ecdsa-sha2-nistp256 AAAAE2Vj')).toBe('');
    expect(publicKeyProblem('')).toBe('');
  });
  it('refuses a private key, several keys and other text', () => {
    expect(publicKeyProblem('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n')).toMatch(/private key/);
    expect(publicKeyProblem(`${KEY}\n${KEY}`)).toMatch(/exactly one/);
    expect(publicKeyProblem('ssh-ed25519')).toMatch(/Not an OpenSSH public key/);
    expect(publicKeyProblem('hello world')).toMatch(/Not an OpenSSH public key/);
  });
  it('suggests the key comment as its title', () => {
    expect(suggestedTitle(`${KEY} alice@laptop`)).toBe('alice@laptop');
    expect(suggestedTitle(KEY)).toBe('');
  });
});

describe('SSH key table', () => {
  it('shows loading, error and empty states', () => {
    expect(table({ loading: true, reload })).toContain('Loading SSH keys');
    const failed = table({ loading: false, error: 'boom', reload });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Retry');
    expect(table({ loading: false, data: { keys: [] }, reload })).toContain('No SSH keys');
  });
  it('lists title, fingerprint and last use with a labelled delete button', () => {
    const key: SshKey = {
      id: 'ssh_0123456789abcdef',
      title: 'laptop',
      fingerprint: 'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
      algorithm: 'ssh-ed25519',
      created_at: 1_793_145_600_000,
      last_used_at: null,
    };
    const html = table({ loading: false, data: { keys: [key] }, reload });
    expect(html).toContain('laptop');
    expect(html).toContain(key.fingerprint);
    expect(html).toContain('never');
    expect(html).toContain('aria-label="Delete SSH key laptop"');
  });
});

describe('SshSetup', () => {
  const setup = (access: unknown) =>
    renderToStaticMarkup(createElement(SshSetup, { access } as never));
  it('shows the tunnel ssh config and the clone URL', () => {
    const html = setup({
      front_door: 'tunnel',
      host: 'ssh.yonedarepo.com',
      clone_url: 'ssh://git@ssh.yonedarepo.com/<repository id>.git',
      ssh_config: 'Host ssh.yonedarepo.com\n  ProxyCommand cloudflared access ssh --hostname %h\n',
    });
    expect(html).toContain('install cloudflared');
    expect(html).toContain(
      '<pre>Host ssh.yonedarepo.com\n  ProxyCommand cloudflared access ssh --hostname %h\n</pre>',
    );
    expect(html).toContain('ssh://git@ssh.yonedarepo.com/&lt;repository id&gt;.git');
  });
  it('says when SSH is not open, and shows nothing while loading', () => {
    expect(setup({ front_door: null, host: null, clone_url: null, ssh_config: null })).toContain(
      'not open yet',
    );
    expect(setup(undefined)).toBe('');
  });
});
