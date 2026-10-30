// The handle prompt's rules: whom it asks, what it refuses before asking the server, and how
// it words the server's refusals.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HandlePicker } from './HandlePicker';
import { handleProblem, handleRefusal, needsHandle } from './handleModel';

describe('handle prompt', () => {
  it('asks only an email-named account the server says has no handle', () => {
    expect(needsHandle({ username: 'ada@example.com', handle: null })).toBe(true);
    expect(needsHandle({ username: 'ada@example.com', handle: 'ada' })).toBe(false);
    // A server without handles says nothing: never ask.
    expect(needsHandle({ username: 'ada@example.com' })).toBe(false);
    expect(needsHandle({ username: 'ada', handle: null })).toBe(false);
    expect(needsHandle(null)).toBe(false);
  });

  it('refuses a malformed handle before asking the server', () => {
    expect(handleProblem('')).toBe('');
    expect(handleProblem('ada_l')).toBe('');
    expect(handleProblem('Ada')).toBe('Use lowercase letters.');
    expect(handleProblem('ad')).toMatch(/3–32/);
    expect(handleProblem('1ada')).toMatch(/starting with a letter/);
    expect(handleProblem('ada-l')).toMatch(/underscores/);
  });

  it('words the server’s refusals', () => {
    expect(handleRefusal('HANDLE_TAKEN', 'ada', 'x')).toBe('ada is taken. Try another.');
    expect(handleRefusal('HANDLE_RESERVED', 'docs', 'x')).toMatch(/reserved/);
    expect(handleRefusal('OTHER', 'ada', 'Server said no')).toBe('Server said no');
  });

  it('opens prefilled with the suggestion and never shows the email', () => {
    const html = renderToStaticMarkup(
      createElement(HandlePicker, { suggestion: 'ada_l', onDone: () => {}, onLater: () => {} }),
    );
    expect(html).toContain('value="ada_l"');
    expect(html).toContain('/ada_l/my-repo');
    expect(html).toContain('Not now');
    expect(html).not.toContain('@');
  });
});
