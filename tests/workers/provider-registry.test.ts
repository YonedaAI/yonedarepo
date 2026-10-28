import registry from '../../backend/crates/yoneda-core/src/provider_registry.json';
import { expect, it } from 'vitest';
import { providerRegistry } from '../../shared/provider-registry';

it('re-exports the yoneda-core provider registry without drift', () => {
  expect(providerRegistry).toEqual(registry);
});
