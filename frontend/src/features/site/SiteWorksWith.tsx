// "Works with any agent": coding agents that drive stock Git, named only here (nominative use;
// the home page's tests ban these names everywhere else). The marks are the brands' own, in
// their monochrome form from @lobehub/icons-static-svg (MIT), painted in the muted color
// through a CSS mask. They scroll in a small window: the list is rendered twice and the track
// moves by half its width, so the loop is seamless; the copy is hidden from screen readers.
import amp from '@lobehub/icons-static-svg/icons/amp.svg';
import claudeCode from '@lobehub/icons-static-svg/icons/claudecode.svg';
import cline from '@lobehub/icons-static-svg/icons/cline.svg';
import codex from '@lobehub/icons-static-svg/icons/codex.svg';
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg';
import geminiCli from '@lobehub/icons-static-svg/icons/geminicli.svg';
import githubCopilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg';
import openCode from '@lobehub/icons-static-svg/icons/opencode.svg';
import { Terminal } from 'lucide-react';
import type { CSSProperties } from 'react';

const AGENTS: [name: string, mark: string][] = [
  ['Claude Code', claudeCode],
  ['Codex', codex],
  ['OpenCode', openCode],
  ['Cursor', cursor],
  ['Gemini CLI', geminiCli],
  ['GitHub Copilot', githubCopilot],
  ['Amp', amp],
  ['Cline', cline],
];

function Marks({ copy }: { copy?: boolean }) {
  return (
    <ul
      className="site-works-with"
      aria-label={copy ? undefined : 'Agents YonedaRepo works with'}
      aria-hidden={copy ? 'true' : undefined}
    >
      {AGENTS.map(([name, mark]) => (
        <li key={name}>
          <span
            className="site-works-mark"
            role="img"
            aria-label={name}
            title={name}
            style={{ '--mark': `url("${mark}")` } as CSSProperties}
          />
        </li>
      ))}
      <li>
        <span
          className="site-works-any"
          role="img"
          aria-label="Any Git client"
          title="Any Git client"
        >
          <Terminal size={18} aria-hidden="true" />
        </span>
      </li>
    </ul>
  );
}

/** The muted strip after the hero's button: the label, then the scrolling marks. */
export function SiteWorksWith() {
  return (
    <div className="site-works">
      <span className="site-works-label">Works with any agent</span>
      <div className="site-marquee">
        <div className="site-marquee-track">
          <Marks />
          <Marks copy />
        </div>
      </div>
    </div>
  );
}
