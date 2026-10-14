import { describe, expect, it } from 'vitest';
import type { Repository } from '../../lib/types';
import { sessionFixture } from './guidedFixture';
import { guidedStepInput } from './guidedStepInput';

const repository = { status: 'ready', head_commit: 'published', version: 1 } as Repository;
describe('guided checked-head request', () => {
  it('continues from the server working lease while canonical publication remains unchanged', () => {
    const session = {
      ...sessionFixture(),
      working_revision: { repository: 'artifacts', commit: 'checked' },
      working_version: 4,
    };
    expect(guidedStepInput(session, 'build', repository)).toMatchObject({
      expected_commit: 'checked',
      expected_version: 4,
    });
  });
  it('uses the canonical lease only before the session has a working revision', () => {
    expect(guidedStepInput(sessionFixture(), 'build', repository)).toMatchObject({
      expected_commit: 'published',
      expected_version: 1,
    });
  });
  it('does not mix a partial branch lease or start a later locked stage', () => {
    expect(() =>
      guidedStepInput(
        { ...sessionFixture(), working_revision: { repository: 'artifacts', commit: 'checked' } },
        'build',
        repository,
      ),
    ).toThrow('working revision');
    expect(() => guidedStepInput(sessionFixture(), 'extend', repository)).toThrow('ready stage');
  });
});
