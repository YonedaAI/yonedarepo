// The welcome email's content (platform side): one plain-text and one HTML part, rendered
// from config only (no account data, so one rendering serves every recipient). The HTML is
// inline-styled with no backgrounds, images or tracking, so it reads the same in light and
// dark mail clients.

export type WelcomeConfig = {
  /** The website (`https://yonedarepo.com`): the docs links and the footer. */
  origin: string;
  /** Where people write to us; also the email's reply-to. */
  contact: string;
};
export type WelcomeEmail = { subject: string; text: string; html: string };

/** The docs pages the steps link to (the public site's /docs routes). */
export const WELCOME_DOCS = {
  cli: '/docs/guides/cli',
  repositories: '/docs/guides/repositories',
  agents: '/docs/guides/sessions',
} as const;

const COMPANY = 'Yoneda Labs';

const INTRO = [
  'YonedaRepo is a Git-compatible source platform where agents and people push, review and land code. Every write is a real Git commit, so any Git client can clone the result.',
  'The coding session behind a change is recorded with it, and the next session starts with that context, so it travels with the code.',
];

function steps(origin: string) {
  return [
    {
      title: 'Install the CLI and sign in',
      body: 'Install the yoneda CLI, then run `yoneda login` to sign this terminal in.',
      href: `${origin}${WELCOME_DOCS.cli}`,
    },
    {
      title: 'Create or import a repository',
      body: 'Start a new repository from the web app or `yoneda repo create`, or bring an existing one with `yoneda repo import`.',
      href: `${origin}${WELCOME_DOCS.repositories}`,
    },
    {
      title: 'Point your agents at it',
      body: 'Agents work through Git, the CLI and MCP. Run `yoneda setup claude` or `yoneda setup opencode`: the plugin records each coding session on the commits it pushed.',
      href: `${origin}${WELCOME_DOCS.agents}`,
    },
  ];
}

function why(origin: string, contact: string) {
  return `You're getting this because a YonedaRepo account was just created with this address at ${origin}. It's a one-time message, not a mailing list. If it wasn't you, ignore it or tell us at ${contact}.`;
}

export function renderWelcome({ origin, contact }: WelcomeConfig): WelcomeEmail {
  const list = steps(origin);
  const text = [
    'Welcome to YonedaRepo',
    '',
    'Your account is ready.',
    '',
    ...INTRO.flatMap((p) => [p, '']),
    'Three steps to get going:',
    '',
    ...list.flatMap((s, i) => [`${i + 1}. ${s.title}`, `   ${s.body}`, `   ${s.href}`, '']),
    `Questions or feedback? Reply to this email or write to ${contact}.`,
    '',
    `The YonedaRepo team at ${COMPANY}`,
    '',
    '--',
    why(origin, contact),
    COMPANY,
    '',
  ].join('\n');
  return { subject: 'Welcome to YonedaRepo', text, html: html(origin, contact, list) };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
/** Escaped prose with `code` spans in a monospace face (a border, not a background). */
const prose = (value: string) =>
  escapeHtml(value).replace(
    /`([^`]+)`/g,
    '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;border:1px solid #888888;border-radius:4px;padding:0 4px">$1</code>',
  );
const link = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="color:#3b82f6;text-decoration:underline">${escapeHtml(label)}</a>`;

function html(origin: string, contact: string, list: ReturnType<typeof steps>) {
  const p = (body: string, style = '') =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5${style}">${body}</p>`;
  const items = list
    .map(
      (s) =>
        `<li style="margin:0 0 16px;font-size:16px;line-height:1.5"><strong>${escapeHtml(s.title)}</strong><br>${prose(s.body)}<br>${link(s.href, 'Read the guide')}</li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Welcome to YonedaRepo</title>
</head>
<body style="margin:0;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:600">Welcome to YonedaRepo</h1>
${p('Your account is ready.')}
${INTRO.map((t) => p(escapeHtml(t))).join('\n')}
${p('Three steps to get going:')}
<ol style="margin:0 0 16px;padding-left:24px">${items}</ol>
${p(`Questions or feedback? Reply to this email or write to ${link(`mailto:${contact}`, contact)}.`)}
${p(`The YonedaRepo team at ${COMPANY}`)}
<hr style="border:0;border-top:1px solid #888888;margin:24px 0 16px">
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#888888">${escapeHtml(why(origin, contact))}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#888888">${COMPANY}</p>
</div>
</body>
</html>
`;
}
