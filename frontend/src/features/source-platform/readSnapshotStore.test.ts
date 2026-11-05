import { expect, it } from 'vitest';
import { ReadSnapshotStore } from './readSnapshotStore';

it('keeps reports separate and never extends their expiry when read', () => {
  let now = 100;
  const store = new ReadSnapshotStore(() => now);
  store.put('/overview', { accounts: 3 });
  expect(store.get('/traffic')).toBeUndefined();
  now += 14999;
  expect(store.get('/overview')).toEqual({ accounts: 3 });
  now++;
  expect(store.get('/overview')).toBeUndefined();
  expect(new ReadSnapshotStore(() => now).get('/overview')).toBeUndefined();
});

it('clears fresh snapshots when the surrounding scope is invalidated', () => {
  const store = new ReadSnapshotStore();
  store.put('/overview', { accounts: 3 });
  const generation = store.generation;
  store.clear();
  store.put('/overview', { accounts: 2 }, generation);
  expect(store.get('/overview')).toBeUndefined();
  store.put('/overview', { accounts: 4 });
  expect(store.get('/overview')).toEqual({ accounts: 4 });
});
