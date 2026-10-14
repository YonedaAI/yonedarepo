import { sourceError } from './source-contract';
import { sourceOid } from './source-path';

/** Assigned private fork ref, independently read back; model/caller selectors never supply it. */
export async function sourceCaptureRef(target: ArtifactsRepo) {
  const branch = (await target.info()).defaultBranch;
  if (
    typeof branch !== 'string' ||
    !branch ||
    new TextEncoder().encode(branch).length > 512 ||
    [...branch].some(
      (character) => (character.codePointAt(0) ?? 0) <= 32 || character.codePointAt(0) === 127,
    ) ||
    /[~^:?*[\\]/.test(branch) ||
    branch === '@' ||
    branch.startsWith('-') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.endsWith('.') ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  )
    throw sourceError('INVALID_CAPTURE', 'Assigned capture fork branch is not a safe Git ref');
  const head = (await target.log({ ref: branch, limit: 1 }))[0];
  if (!head) throw sourceError('INVALID_CAPTURE', 'Assigned capture fork branch is missing');
  return { branch, expected_head: sourceOid(head.hash) };
}
