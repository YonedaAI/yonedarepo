// A file nested deeper than the parsers' recursion fits in Wasm's 1 MiB stack (Rust blocks
// overflow it from about 300 levels, script arrays from about 600) trapped the isolate
// (`memory access out of bounds`) on every Overview of a revision holding it. Such a file
// is listed with a parse error instead, and the rest of the revision is analysed.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const nested = (open: string, close: string, depth: number) => `${open.repeat(depth)}${close.repeat(depth)}`;

it('analyses a revision holding deeply nested files, naming them as unparsed', async () => {
  const owner = { cookie: await signup('view_nesting') };
  const files = [
    file('src/lib.rs', 'pub fn retry() -> u32 {\n    1\n}\n'),
    file('src/deep.rs', `pub fn deep() ${nested('{', '}', 400)}\n`),
    file('src/deep.js', `export const deep = ${nested('[', ']', 800)};\n`),
  ];
  const created = await api('/repos', owner, { body: { name: 'view-nesting', policy: { required_checks: [], approvals: 0 }, files, author } });
  const view = await api(`/repos/${created.body.id}/views/human?path=&ref=main`, owner);
  expect(view.status, JSON.stringify(view.body).slice(0, 300)).toBe(200);
  const [src] = view.body.subsystems;
  expect(src.parse_errors).toEqual(['src/deep.js', 'src/deep.rs']);
  expect(src.kinds).toEqual({ function: 1 });
  // Asked again: served, not a trapped isolate's leftovers.
  expect((await api(`/repos/${created.body.id}/views/human?path=&ref=main`, owner)).status).toBe(200);
});
