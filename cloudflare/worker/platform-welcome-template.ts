// The account emails' content (platform side): the welcome email and the email-confirmation
// email, each one plain-text and one HTML part, rendered from config and the recipient's
// confirmation link. The HTML is inline-styled with no backgrounds, images or tracking, so it
// reads the same in light and dark mail clients.

export type WelcomeConfig = {
  /** The website (`https://yonedarepo.com`): the docs links and the footer. */
  origin: string;
  /** Where people write to us; also the email's reply-to. */
  contact: string;
  /** The single-use confirmation page link, while the address is unconfirmed. */
  verifyUrl?: string;
};
export type WelcomeEmail = { subject: string; text: string; html: string };

/** The docs pages the steps link to (the public site's /docs routes). */
export const WELCOME_DOCS = {
  cli: '/docs/guides/cli',
  repositories: '/docs/guides/repositories',
  agents: '/docs/guides/sessions',
} as const;

const COMPANY = 'Yoneda Labs';
const LINK_TERMS = 'The link works once, for 24 hours.';

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

/** One email's parts, as blocks shared by its text and HTML forms. */
type Block =
  | { kind: 'p'; text: string }
  | { kind: 'link'; text: string; href: string; label: string }
  | { kind: 'steps'; items: ReturnType<typeof steps> }
  | { kind: 'contact' };
type Email = { subject: string; heading: string; blocks: Block[]; why: string };

export function renderWelcome({ origin, contact, verifyUrl }: WelcomeConfig): WelcomeEmail {
  return render(contact, {
    subject: 'Welcome to YonedaRepo',
    heading: 'Welcome to YonedaRepo',
    blocks: [
      { kind: 'p', text: 'Your account is ready.' },
      ...(verifyUrl
        ? [
            {
              kind: 'link' as const,
              text: `Please confirm this email address. ${LINK_TERMS}`,
              href: verifyUrl,
              label: 'Confirm your email',
            },
          ]
        : []),
      ...INTRO.map((text) => ({ kind: 'p' as const, text })),
      { kind: 'p', text: 'Three steps to get going:' },
      { kind: 'steps', items: steps(origin) },
      { kind: 'contact' },
    ],
    why: `You're getting this because a YonedaRepo account was just created with this address at ${origin}. It's a one-time message, not a mailing list. If it wasn't you, ignore it or tell us at ${contact}.`,
  });
}

export function renderVerify({
  origin,
  contact,
  verifyUrl,
}: WelcomeConfig & { verifyUrl: string }): WelcomeEmail {
  return render(contact, {
    subject: 'Confirm your email for YonedaRepo',
    heading: 'Confirm your email',
    blocks: [
      {
        kind: 'link',
        text: `Open the link and press Confirm to use this address for your YonedaRepo account. ${LINK_TERMS}`,
        href: verifyUrl,
        label: 'Confirm your email',
      },
      {
        kind: 'p',
        text: "If you didn't ask for this, ignore this email: nothing changes until the link is used.",
      },
      { kind: 'contact' },
    ],
    why: `You're getting this because someone asked to use this address for a YonedaRepo account at ${origin}. If it wasn't you, ignore it or tell us at ${contact}.`,
  });
}

function render(contact: string, email: Email): WelcomeEmail {
  const contactLine = `Questions or feedback? Reply to this email or write to ${contact}.`;
  const text = [
    email.heading,
    '',
    ...email.blocks.flatMap((b) => {
      if (b.kind === 'p') return [b.text, ''];
      if (b.kind === 'link') return [b.text, b.href, ''];
      if (b.kind === 'contact') return [contactLine, '', `The YonedaRepo team at ${COMPANY}`, ''];
      return b.items.flatMap((s, i) => [
        `${i + 1}. ${s.title}`,
        `   ${s.body}`,
        `   ${s.href}`,
        '',
      ]);
    }),
    '--',
    email.why,
    COMPANY,
    '',
  ].join('\n');
  return { subject: email.subject, text, html: html(contact, email) };
}

export const escapeHtml = (value: string) =>
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

function html(contact: string, email: Email) {
  const p = (body: string) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5">${body}</p>`;
  const block = (b: Block) => {
    if (b.kind === 'p') return p(escapeHtml(b.text));
    if (b.kind === 'link')
      return `${p(escapeHtml(b.text))}\n${p(`<strong>${link(b.href, b.label)}</strong>`)}`;
    if (b.kind === 'contact')
      return `${p(`Questions or feedback? Reply to this email or write to ${link(`mailto:${contact}`, contact)}.`)}\n${p(`The YonedaRepo team at ${COMPANY}`)}`;
    const items = b.items
      .map(
        (s) =>
          `<li style="margin:0 0 16px;font-size:16px;line-height:1.5"><strong>${escapeHtml(s.title)}</strong><br>${prose(s.body)}<br>${link(s.href, 'Read the guide')}</li>`,
      )
      .join('');
    return `<ol style="margin:0 0 16px;padding-left:24px">${items}</ol>`;
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(email.subject)}</title>
</head>
<body style="margin:0;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:600">${escapeHtml(email.heading)}</h1>
${email.blocks.map(block).join('\n')}
<hr style="border:0;border-top:1px solid #888888;margin:24px 0 16px">
<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#888888">${escapeHtml(email.why)}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#888888">${COMPANY}</p>
</div>
</body>
</html>
`;
}
