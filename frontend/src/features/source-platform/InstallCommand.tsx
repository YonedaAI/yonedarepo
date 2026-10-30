// The one command that installs the CLI, for the visitor's operating system or the other one,
// so Copy always gives a single runnable line.
import { useState } from 'react';
import { type InstallOs, installCommand, installOs, windowsInstallCommand } from './connect';
import { CopyBlock } from './TokenParts';

const CHOICES: { os: InstallOs; label: string }[] = [
  { os: 'unix', label: 'macOS & Linux' },
  { os: 'windows', label: 'Windows' },
];

export function InstallCommand({ origin }: { origin: string }) {
  const [os, setOs] = useState(() => installOs(globalThis.navigator?.userAgent));
  return (
    <>
      <fieldset className="segmented">
        <legend className="sr-only">Operating system</legend>
        {CHOICES.map((choice) => (
          <button
            key={choice.os}
            type="button"
            aria-pressed={os === choice.os}
            onClick={() => setOs(choice.os)}
          >
            {choice.label}
          </button>
        ))}
      </fieldset>
      <CopyBlock
        label="Install the yoneda CLI"
        text={os === 'windows' ? windowsInstallCommand(origin) : installCommand(origin)}
      />
    </>
  );
}
