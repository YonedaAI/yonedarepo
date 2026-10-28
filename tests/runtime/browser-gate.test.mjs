import assert from 'node:assert/strict';
import { test } from 'node:test';
import { see } from '../../tools/staging/browser-collab-flow.mjs';
import { cookieHeader, scrub, settle } from '../../tools/staging/browser-flow.mjs';

test('cookie header joins every cookie', () => {
  assert.equal(cookieHeader([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]), 'a=1; b=2');
});

test('scrub removes secrets from evidence and ignores empty ones', () => {
  assert.equal(scrub('pw=hunter22 again hunter22', ['hunter22', '', undefined]), 'pw=[redacted] again [redacted]');
});

const shown = (visible, text = '') => ({ first: () => shown(visible, text), isVisible: async () => visible, innerText: async () => text });

test('settle returns when the expected element shows', async () => {
  await settle(shown(true), [shown(true, 'ignored')], { timeoutMs: 1000, what: 'ok' });
});

test('settle stops at the first visible failure with its text', async () => {
  await assert.rejects(settle(shown(false), [shown(false), shown(true, 'STALE_HEAD: main moved')], { timeoutMs: 5000, what: 'publication' }), /publication: STALE_HEAD: main moved/);
});

test('settle times out when nothing shows', async () => {
  await assert.rejects(settle(shown(false), [], { timeoutMs: 0, what: 'sign-in' }), /Timed out waiting for sign-in/);
});

test('see names what is missing instead of the selector dump', async () => {
  const missing = { first: () => ({ waitFor: async () => Promise.reject(new Error('Timeout 10ms exceeded.\nCall log: …')) }) };
  await assert.rejects(see(missing, 'the Releases empty state', 10), /^Error: the Releases empty state is not shown \(Timeout 10ms exceeded\.\)$/);
  await see({ first: () => ({ waitFor: async () => {} }) }, 'anything');
});
