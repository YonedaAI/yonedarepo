// Forks in the browser: the requests the Fork button and a change opened against a fork's
// parent send, and which branches a fork may propose where.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ForkButton } from './ForkButton';
import { changeRequest, forkRequest } from './forks';
import { OpenChangeButton } from './OpenChange';

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const repo = 'r00000000000000000f01';
const parent = 'r00000000000000000a01';
const change = { branch: 'feature', title: '  Fork work ', body: '' };

describe('fork requests', () => {
  it('forks with a name, or keeps the parent name when blank', () => {
    expect(forkRequest(parent, '  mine ')).toEqual({
      path: `/repos/${parent}/fork`,
      body: { name: 'mine' },
    });
    expect(forkRequest(parent, '   ').body).toEqual({});
  });

  it('opens a change here, or on the parent naming the fork', () => {
    expect(changeRequest(repo, parent, 'here', change)).toEqual({
      repo,
      path: `/repos/${repo}/changes`,
      body: { branch: 'feature', title: 'Fork work', body: undefined },
    });
    expect(changeRequest(repo, parent, 'parent', { ...change, body: ' Why ' })).toEqual({
      repo: parent,
      path: `/repos/${parent}/changes`,
      body: { fork: repo, branch: 'feature', title: 'Fork work', body: 'Why' },
    });
    // Not a fork: the parent target falls back to this repository.
    expect(changeRequest(repo, undefined, 'parent', change).repo).toBe(repo);
  });
});

describe('fork controls', () => {
  it('offers main of a fork to its parent only, and other branches either way', () => {
    const onOpened = () => {};
    expect(html(OpenChangeButton, { repo, branch: 'main', onOpened })).toBe('');
    expect(html(OpenChangeButton, { repo, branch: 'main', parent, onOpened })).toContain(
      'Open change',
    );
    expect(html(OpenChangeButton, { repo, branch: 'refs/heads/release/1', parent, onOpened })).toBe(
      '',
    );
    expect(html(OpenChangeButton, { repo, branch: 'feature', parent, onOpened })).toContain(
      'Open change',
    );
  });

  it('starts as a Fork button', () => {
    expect(html(ForkButton, { repo, name: 'upstream', onForked: () => {} })).toContain('>Fork<');
  });
});
