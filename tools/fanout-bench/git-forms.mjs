// The Git smart HTTP requests a regional client sends in place of Git (a Worker can't run it):
// what `git clone` and `git push` of one small commit put on the wire, built here and replayed
// there as bytes. Protocol v2 for reading, a whole small pack for writing.
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const ZERO = '0'.repeat(40);
const V2 = { 'git-protocol': 'version=2' };
const REQUEST = (service) => ({ ...V2, 'content-type': `application/x-git-${service}-request`, accept: `application/x-git-${service}-result` });

const pkt = (line) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
const b64 = (data) => Buffer.from(data).toString('base64');

/** What a client sends to read `want`: the ref advertisement, ls-refs, then the pack. */
export function cloneSteps(repo, token, want) {
  const path = `/git/${repo}.git`;
  const lsRefs = `${pkt('command=ls-refs\n')}${pkt('object-format=sha1\n')}0001${pkt('peel\n')}${pkt('symrefs\n')}${pkt('ref-prefix refs/heads/\n')}0000`;
  const fetch = `${pkt('command=fetch\n')}${pkt('object-format=sha1\n')}0001${pkt('thin-pack\n')}${pkt('ofs-delta\n')}${pkt(`want ${want}\n`)}${pkt('done\n')}0000`;
  return [
    { label: 'clone.refs', path: `${path}/info/refs?service=git-upload-pack`, token, headers: V2 },
    { label: 'clone.ls', path: `${path}/git-upload-pack`, token, headers: REQUEST('upload-pack'), body_b64: b64(lsRefs), contains: 'refs/heads/' },
    { label: 'clone.pack', path: `${path}/git-upload-pack`, token, headers: REQUEST('upload-pack'), body_b64: b64(fetch), contains: 'packfile' },
  ];
}

const oid = (kind, data) => createHash('sha1').update(`${kind} ${data.length}\0`).update(data).digest('hex');
const KIND = { commit: 1, tree: 2, blob: 3 };

/** One packed object: its type and size in the first bytes, then its deflated data. */
function packed(kind, data) {
  let size = data.length;
  let byte = (KIND[kind] << 4) | (size & 15);
  size >>>= 4;
  const header = [];
  while (size > 0) {
    header.push(byte | 0x80);
    byte = size & 0x7f;
    size >>>= 7;
  }
  header.push(byte);
  return Buffer.concat([Buffer.from(header), deflateSync(data)]);
}

const blob = (text) => {
  const data = Buffer.from(text);
  return { kind: 'blob', data, id: oid('blob', data) };
};

/** A tree of flat files: `{name: blob id}`, in Git's order. */
export function flatTree(files) {
  const entries = Object.keys(files)
    .sort()
    .map((name) => Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(files[name], 'hex')]));
  const data = Buffer.concat(entries);
  return { kind: 'tree', data, id: oid('tree', data) };
}

/** Blob ids of `files` (`{name: text}`), as the platform will hold them. */
export const blobIds = (files) => Object.fromEntries(Object.entries(files).map(([name, text]) => [name, blob(text).id]));

/** A commit on `parent` adding one file to the tree `files` (`{name: blob id}`), packed whole. */
export function commitPack({ parent, files, name, text, at }) {
  const added = blob(text);
  const tree = flatTree({ ...files, [name]: added.id });
  const who = `Real use <bench@yonedarepo.invalid> ${at} +0000`;
  const data = Buffer.from(`tree ${tree.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\n${name}\n`);
  const commit = { kind: 'commit', data, id: oid('commit', data) };
  const objects = [commit, tree, added];
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length);
  const pack = Buffer.concat([Buffer.from('PACK\0\0\0\x02', 'latin1'), count, ...objects.map((o) => packed(o.kind, o.data))]);
  return { commit: commit.id, pack: Buffer.concat([pack, createHash('sha1').update(pack).digest()]) };
}

/** The request that creates `ref` at `commit` with `pack`. */
export function pushSteps(repo, token, { ref, commit, pack }) {
  const path = `/git/${repo}.git`;
  const line = `${ZERO} ${commit} ${ref}\0 report-status agent=yoneda-bench\n`;
  const body = Buffer.concat([Buffer.from(`${pkt(line)}0000`), pack]);
  return [
    { label: 'push.refs', path: `${path}/info/refs?service=git-receive-pack`, token },
    { label: 'push.pack', path: `${path}/git-receive-pack`, token, headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' }, body_b64: body.toString('base64'), contains: `ok ${ref}` },
  ];
}
