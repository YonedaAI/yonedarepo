import { expect, it } from 'vitest';
import { defaults, modelOptions } from '../../frontend/src/features/workspace/providerModels';

it('keeps the cost-sensitive default selected while preserving saved custom models', () => {
  const saved = [{ provider: 'codex', model: 'account-specific-model' }];
  const options = modelOptions('codex', saved, defaults.codex);
  expect(options[0].id).toBe('gpt-5.6-luna');
  expect(options.some((option) => option.id === saved[0].model)).toBe(true);
  expect(modelOptions('codex', saved, 'another-custom-model').at(-1)?.id).toBe('another-custom-model');
});

it('defaults to the cheaper Sonnet while preserving explicit legacy support and rejecting arbitrary models', () => {
  const saved = [{ provider: 'claude', model: 'unsupported-model' }];
  expect(modelOptions('claude', saved, saved[0].model).map((option) => option.id)).toEqual([
    'claude-sonnet-5-5',
    'claude-sonnet-4-6',
  ]);
  expect(defaults.claude).toBe('claude-sonnet-5-5');
});
