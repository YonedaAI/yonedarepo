import { expect, it } from 'vitest';
import cases from '../../backend/crates/yoneda-core/src/account_identifiers.json';
import { decodeAccountIdentifier, encodeAccountIdentifier, normalizeAccountIdentifier } from '../../shared/account';

it('matches the Rust account identifier contract and preserves safe legacy token segments', () => {
  for (const { input, canonical } of cases) {
    expect(normalizeAccountIdentifier(input), input).toBe(canonical);
    if (canonical) {
      const encoded = encodeAccountIdentifier(canonical);
      expect(encoded).not.toContain('.');
      expect(decodeAccountIdentifier(encoded)).toBe(canonical);
      if (!canonical.includes('@')) expect(encoded).toBe(canonical);
    }
  }
  const max = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  expect(max.length).toBe(254);
  expect(normalizeAccountIdentifier(max)).toBe(max);
  expect(normalizeAccountIdentifier(max + 'e')).toBeNull();
  expect(normalizeAccountIdentifier(`${'a'.repeat(65)}@example.com`)).toBeNull();
});
