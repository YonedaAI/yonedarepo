// A repository with no commits, for someone who can push to it: the three lines from nothing to
// a first push, each ready to copy.
import { installCommand, setUpstreamCommand, yonedaCloneCommand } from './connect';
import { CopyBlock } from './TokenParts';

export function RepoFirstSteps({ repo, origin }: { repo: string; origin: string }) {
  return (
    <div className="repo-first-steps">
      <CopyBlock label="Install the CLI" text={installCommand(origin)} />
      <CopyBlock label="Clone" text={yonedaCloneCommand(repo)} />
      <CopyBlock label="Or set upstream in a project you have" text={setUpstreamCommand(repo)} />
    </div>
  );
}
