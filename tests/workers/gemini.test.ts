import { expect, it } from 'vitest';
import { prepareModelRequest } from '../../worker/model-policy';
import { checkRuntime } from '../../worker/runtime';
const job = { kind: 'agent', model: 'gemini-3.8-flash', payload: { execution: { harness: 'gemini', provider: 'gemini' } } };
it('pins Gemini model and API host, bounds output and blocks paid server tools and media', () => {
  const prepare = (body: object, path = '/v1beta/models/expensive:streamGenerateContent') => prepareModelRequest(job, 'gemini', path, body);
  const result = prepare({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { maxOutputTokens: 999999 }, cachedContent: 'other-owner', tools: [{ functionDeclarations: [{ name: 'read_file', parameters: { type: 'object' } }] }] });
  expect(result.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
  expect(result.body.generationConfig.maxOutputTokens).toBe(4096);
  expect(result.body.cachedContent).toBeUndefined();
  expect(() => prepare({ tools: [{ googleSearch: {} }] })).toThrow();
  expect(() => prepare({ contents: [{ parts: [{ fileData: { fileUri: 'gs://private' } }] }] })).toThrow();
  expect(() => prepare({}, '/v1beta/files')).toThrow();
  expect(() => prepareModelRequest(job, 'claude', '/v1/messages', {})).toThrow();
});
it('refuses Gemini jobs on an old container image before inference', () => {
  expect(() => checkRuntime({ protocol: 2 }, job)).toThrow();
  expect(() => checkRuntime({ protocol: 2, harnesses: ['codex', 'claude', 'gemini'] }, job)).not.toThrow();
});
