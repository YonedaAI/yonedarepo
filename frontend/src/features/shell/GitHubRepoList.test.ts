import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GitHubRepoList } from './GitHubRepoList';

const repo = { id: 1, full_name: 'acme/app', private: true };
const list = (props: Partial<Parameters<typeof GitHubRepoList>[0]>) =>
  renderToStaticMarkup(
    createElement(GitHubRepoList, {
      repositories: [repo],
      matching: [repo],
      busy: false,
      onPick: () => {},
      onOpenGitHub: () => {},
      ...props,
    }),
  );

describe('GitHubRepoList', () => {
  it('ends with GitHub’s install page, for any account or organization, in a new tab', () => {
    const html = list({});
    expect(html).toContain('href="/github/connect?add=1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('Add another repository');
    expect(html.indexOf('acme/app')).toBeLessThan(html.indexOf('Add another repository'));
  });

  it('still offers it with nothing to list', () => {
    const html = list({ repositories: [], matching: [] });
    expect(html).toContain('No repositories shared yet.');
    expect(html).toContain('Add another repository');
    expect(html).not.toContain('<ul');
  });

  it('offers it when the field matches nothing, without saying there are none', () => {
    const html = list({ matching: [] });
    expect(html).toContain('Add another repository');
    expect(html).not.toContain('No repositories');
  });
});
