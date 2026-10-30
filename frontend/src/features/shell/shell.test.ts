// The shell's sidebar rows and its New repository dialog (seed, request body and labels).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceApiError } from '../source-platform/sourceApi';
import {
  CREATE_BUSY,
  CREATE_SLOW,
  createBody,
  createFailure,
  NewRepositoryDialog,
  readmeSeed,
  requestCreate,
} from './NewRepositoryDialog';
import { matchRows, repoRows, rowLabel } from './repoRows';

const a = 'r0000000000000000000a';
const b = 'r0000000000000000000b';

describe('repository rows', () => {
  it("sorts by name, labels another account's repository with its owner and role, and falls back to the id", () => {
    const rows = repoRows([
      { id: a, name: 'shared', owner: 'ada', role: 'write' },
      { id: b, name: '' },
      { id: 'r0000000000000000000c', name: 'mine', owner: 'me', role: 'owner' },
    ]);
    expect(rows.map((r) => r.name)).toEqual(
      ['mine', b, 'shared'].sort((x, y) => x.localeCompare(y)),
    );
    expect(rows.find((r) => r.repo === a)?.shared).toBe('ada · write');
    expect(rows.find((r) => r.name === 'mine')?.shared).toBeUndefined();
    expect(rows.find((r) => r.repo === b)?.name).toBe(b);
  });
});

describe('public repository rows', () => {
  it('marks only public repositories, and says so in the spoken name', () => {
    const rows = repoRows([
      { id: a, name: 'open', visibility: 'public' },
      { id: b, name: 'closed', visibility: 'private' },
      { id: 'r0000000000000000000c', name: 'old' },
      {
        id: 'r0000000000000000000d',
        name: 'theirs',
        owner: 'ada',
        role: 'read',
        visibility: 'public',
      },
    ]);
    const by = (name: string) => rows.find((r) => r.name === name);
    expect(by('open')?.public).toBe(true);
    expect(by('closed')?.public).toBeUndefined();
    expect(by('old')?.public).toBeUndefined();
    expect(rowLabel(by('open') as (typeof rows)[number])).toBe('open, public');
    expect(rowLabel(by('theirs') as (typeof rows)[number])).toBe('theirs, ada · read, public');
    expect(rowLabel(by('closed') as (typeof rows)[number])).toBeUndefined();
  });
});

describe('new repository request', () => {
  it('sends the chosen visibility, private unless public was picked', () => {
    expect(createBody('demo', '', '').visibility).toBe('private');
    expect(createBody('demo', '', '', 'public')).toMatchObject({
      name: 'demo',
      visibility: 'public',
    });
    expect(createBody('demo', '', 'acme', 'private')).toMatchObject({
      owner: 'acme',
      visibility: 'private',
    });
    expect(createBody('demo', '', '')).not.toHaveProperty('owner');
  });
});

describe('a create that stalls or fails', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives up on a request the server never answers, saying what to do', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    const failure = await requestCreate(createBody('demo', '', ''), 5).catch((e) => e);
    expect(createFailure(failure)).toBe(CREATE_SLOW);
  });

  it('says a retryable refusal can be tried again, and keeps every other message', () => {
    const refused = (status: number, code: string, message: string) =>
      new SourceApiError(code, message, status);
    expect(createFailure(refused(503, 'CREATE_UNAVAILABLE', 'raw'))).toBe(CREATE_BUSY);
    expect(createFailure(refused(503, 'OVERLOADED', 'raw'))).toBe(CREATE_BUSY);
    expect(createFailure(refused(409, 'NAME_TAKEN', 'Taken'))).toBe('Taken');
    expect(createFailure(refused(500, 'INTERNAL', 'Reference: abc'))).toBe('Reference: abc');
  });
});

describe('new repository seed', () => {
  it('titles the README with the name and adds the description (UTF-8 safe)', () => {
    const decode = (b64: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
    expect(decode(readmeSeed('demo', ''))).toBe('# demo\n');
    expect(decode(readmeSeed('demo', '  Café ✓ notes \n'))).toBe('# demo\n\nCafé ✓ notes\n');
  });
});

describe('the New repository dialog', () => {
  /** Each `<label>`'s text, tags stripped (what getByLabel matches against). */
  const labels = (html: string) =>
    [...html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((m) => ({
      text: m[1].replace(/<[^>]+>/g, '').trim(),
      html: m[1],
    }));
  const dialog = renderToStaticMarkup(
    createElement(NewRepositoryDialog, {
      account: 'ada',
      orgs: [{ org: 'kit_org_1', role: 'owner' }],
      onClose: () => {},
      onCreated: async () => {},
    }),
  );

  it('labels exactly one control "Owner", the owner picker', () => {
    const owner = labels(dialog).filter((l) => /owner/i.test(l.text));
    expect(owner).toHaveLength(1);
    expect(owner[0].html).toContain('<select name="owner"');
    expect(owner[0].html).toContain('kit_org_1');
  });

  it('names each visibility radio by its label alone and describes it with its help', () => {
    const radios = labels(dialog).filter((l) => l.html.includes('type="radio"'));
    expect(radios.map((l) => l.text)).toEqual(['Private', 'Public']);
    expect(dialog).toContain('aria-describedby="visibility-private-help"');
    expect(dialog).toMatch(/<small id="visibility-private-help">Only the owner and members/);
    expect(dialog).toContain('<legend>Visibility</legend>');
  });
});

describe('repository switcher', () => {
  it('filters by name or owner, ignoring case and spaces around the query', () => {
    const rows = repoRows([
      { id: a, name: 'Parser', owner: 'me', role: 'owner' },
      { id: b, name: 'docs', owner: 'ada', role: 'write' },
      { id: 'r0000000000000000000c', name: 'parse-tools', owner: 'me', role: 'owner' },
    ]);
    expect(matchRows(rows, '  PARS ').map((r) => r.name)).toEqual(['parse-tools', 'Parser']);
    expect(matchRows(rows, 'ada').map((r) => r.name)).toEqual(['docs']);
    expect(matchRows(rows, '')).toBe(rows);
    expect(matchRows(rows, 'zzz')).toEqual([]);
  });
});
