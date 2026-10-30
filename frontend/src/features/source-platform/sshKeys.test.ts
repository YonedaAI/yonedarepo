import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SshCloneLine } from './CodeParts';
import { SshKeyDialog, SshKeyTable, SshSetup } from './SshKeys';
import { publicKeyProblem, type SshKey, sshCloneCommand, suggestedTitle } from './sshKeyModel';
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

describe('adding an SSH key', () => {
  const dialog = () =>
    renderToStaticMarkup(createElement(SshKeyDialog, { onAdded: () => {}, onClose: () => {} }));
  it('asks for the title and the public key in a dialog, with the CLI way beside them', () => {
    const html = dialog();
    expect(html).toContain('id="ssh-title"');
    expect(html).toContain('<textarea id="ssh-key"');
    expect(html).toContain('yoneda ssh-key add');
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Add SSH key<\/button>/);
  });
});

describe('SshSetup', () => {
  const setup = (access: unknown) =>
    renderToStaticMarkup(
      createElement(SshSetup, { access, origin: 'https://api.yonedarepo.com' } as never),
    );
  const tunnel = {
    front_door: 'tunnel',
    host: 'ssh.yonedarepo.com',
    clone_url: 'ssh://git@ssh.yonedarepo.com/<repository id>.git',
    ssh_config: 'Host ssh.yonedarepo.com\n  ProxyCommand cloudflared access ssh --hostname %h\n',
  };
  it('gives two commands, each one Copy: install, then yoneda ssh setup', () => {
    const html = setup(tunnel);
    expect(html).toContain('aria-label="Copy Install the yoneda CLI"');
    expect(html).toContain('<code>curl -fsSL https://yonedarepo.com/install.sh | sh</code>');
    expect(html).toContain('aria-label="Copy Set up SSH on this machine"');
    expect(html).toContain('<code>yoneda ssh setup</code>');
    expect(html).toContain('ssh://git@ssh.yonedarepo.com/&lt;repository id&gt;.git');
  });
  it('offers both operating systems, the current one pressed', () => {
    const html = setup(tunnel);
    expect(html).toContain('>macOS &amp; Linux</button>');
    expect(html).toContain('>Windows</button>');
    expect(html).toMatch(/aria-pressed="true"[^>]*>macOS &amp; Linux/);
  });
  it('keeps the config lines behind Manual setup, only on the tunnel', () => {
    const html = setup(tunnel);
    expect(html).toContain('<summary>Manual setup</summary>');
    expect(html).toContain(
      '<pre>Host ssh.yonedarepo.com\n  ProxyCommand cloudflared access ssh --hostname %h\n</pre>',
    );
    expect(html).not.toContain('Once per machine');
    expect(setup({ ...tunnel, front_door: 'connect', ssh_config: null })).not.toContain(
      'Manual setup',
    );
  });
  it('says when SSH is not open, and shows nothing while loading', () => {
    expect(setup({ front_door: null, host: null, clone_url: null, ssh_config: null })).toContain(
      'not open yet',
    );
    expect(setup(undefined)).toBe('');
  });
});

describe('SSH in the Clone menu', () => {
  const REPO = 'r0123456789abcdef0123';
  const tunnel = {
    front_door: 'tunnel' as const,
    host: 'ssh.dev.yonedarepo.com',
    clone_url: 'ssh://git@ssh.dev.yonedarepo.com/<repository id>.git',
    ssh_config:
      'Host ssh.dev.yonedarepo.com\n  ProxyCommand cloudflared access ssh --hostname %h\n',
  };
  const off = { front_door: null, host: null, clone_url: null, ssh_config: null };
  const line = (access: unknown) =>
    renderToStaticMarkup(createElement(SshCloneLine, { access, repo: REPO } as never));
  it('builds the clone command only while SSH is open', () => {
    expect(sshCloneCommand(tunnel, REPO)).toBe(
      `git clone ssh://git@ssh.dev.yonedarepo.com/${REPO}.git`,
    );
    expect(sshCloneCommand(tunnel, REPO, 'demo')).toBe(
      `git clone ssh://git@ssh.dev.yonedarepo.com/${REPO}.git demo`,
    );
    expect(sshCloneCommand(off, REPO)).toBeNull();
    expect(sshCloneCommand(undefined, REPO)).toBeNull();
    expect(sshCloneCommand({ ...tunnel, host: 'evil.com"><x' }, REPO)).toBeNull();
  });
  it('shows the SSH line with Copy, and the setup hint only on the tunnel', () => {
    const shown = line(tunnel);
    expect(shown).toContain(`git clone ssh://git@ssh.dev.yonedarepo.com/${REPO}.git`);
    const named = renderToStaticMarkup(
      createElement(SshCloneLine, { access: tunnel, repo: REPO, name: 'demo' }),
    );
    expect(named).toContain(
      `<code>git clone ssh://git@ssh.dev.yonedarepo.com/${REPO}.git demo</code>`,
    );
    expect(shown).toContain('aria-label="Copy SSH"');
    expect(shown).toContain('href="/settings/ssh-keys"');
    expect(shown).toContain('yoneda ssh setup');
    const direct = line({ ...tunnel, front_door: 'connect', ssh_config: null });
    expect(direct).toContain('Copy SSH');
    expect(direct).not.toContain('/settings/ssh-keys');
    expect(line(off)).toBe('');
    expect(line(undefined)).toBe('');
  });
});
