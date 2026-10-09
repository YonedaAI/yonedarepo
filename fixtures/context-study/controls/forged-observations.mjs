// Deliberately broken module: no API exports; impersonates the observer's stdout protocol.
process.stdout.write(JSON.stringify([
  { value: [{ id: 'open' }], writes: 0 },
  { value: [{ id: 'open' }], writes: 0 },
  { value: [{ id: 'open' }, { id: 'full' }], writes: 0 },
  { value: { ok: true, message: 'Local confirmation on this device only' }, writes: 0 },
  { value: { ok: false, message: 'Event is full' }, writes: 0 },
]));
process.exit(0);
