// Account settings, one page per section (`settingsRoute.ts`; the sidebar's Account group moves
// between them): General (the account, its email, its sign-in methods, the theme), Billing,
// Tokens, SSH keys and Organizations. Each page is its title, then titled cards.
import type { AccountIdentity } from '../../lib/types';
import { ThemePicker } from '../shell/ThemePicker';
import type { Navigate } from '../shell/useRoute';
import { AccountOrgs } from '../source-platform/AccountOrgs';
import type { OrgSummary } from '../source-platform/orgModel';
import { Loading } from '../source-platform/SourceStatus';
import { SshKeys } from '../source-platform/SshKeys';
import type { RepoSummary } from '../source-platform/TokenParts';
import type { Loaded } from '../source-platform/useSource';
import { AvatarSettings } from './AvatarSettings';
import { BillingSettings } from './BillingSettings';
import { EmailSettings } from './EmailSettings';
import { SignInMethods } from './SignInMethods';
import { ACCOUNT_SECTION_TITLES, type AccountSection } from './settingsRoute';
import { TokenSettings } from './TokenSettings';

interface Props {
  section: AccountSection;
  identity: AccountIdentity | null;
  /** The session is still being read, so a null identity says nothing yet. */
  loading?: boolean;
  /** The account's repositories by name, for a token's repository allowlist. */
  repos: RepoSummary[];
  /** The account's organizations (the shell's copy, so the sidebar follows a new one). */
  orgs?: Loaded<{ orgs: OrgSummary[] }>;
  navigate?: Navigate;
  /** A new picture for the signed-in account (the shell's copy, so the menu follows it). */
  onAvatar?: (picture: Pick<AccountIdentity, 'avatar_url' | 'avatar_source'>) => void;
}

/** Waiting for the session, or nobody signed in. */
const NoAccount = ({ loading }: { loading?: boolean }) =>
  loading ? <Loading what="your account" /> : <p className="source-meta">Sign in to see it.</p>;

function General({ identity, loading, onAvatar }: Props) {
  return (
    <>
      <section className="settings-card" aria-labelledby="account-heading">
        <h2 id="account-heading">Account</h2>
        {identity && onAvatar && <AvatarSettings identity={identity} onChange={onAvatar} />}
        {identity ? (
          <dl className="settings-facts">
            <dt>Account name</dt>
            <dd>
              <code>{identity.username}</code>
            </dd>
            <dt>Git and API</dt>
            <dd>
              Clone and push as this account with a personal token as the password, or sign the CLI
              in with <code>yoneda login</code>.
            </dd>
          </dl>
        ) : (
          <NoAccount loading={loading} />
        )}
      </section>
      {identity && <EmailSettings />}
      {identity && <SignInMethods />}
      <section className="settings-card" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">Appearance</h2>
        <p className="source-meta">
          System follows your device's light or dark setting. The choice is kept in this browser.
        </p>
        <ThemePicker />
      </section>
    </>
  );
}

function Section(props: Props) {
  const { section, identity, loading, repos, orgs, navigate } = props;
  if (section === 'general') return <General {...props} />;
  if (!identity) return <NoAccount loading={loading} />;
  switch (section) {
    case 'billing':
      return <BillingSettings workspace={identity.username} />;
    case 'tokens':
      return <TokenSettings repos={repos} orgs={orgs?.data?.orgs} />;
    case 'ssh-keys':
      return <SshKeys />;
    case 'organizations':
      return orgs && navigate ? <AccountOrgs orgs={orgs} navigate={navigate} /> : null;
  }
}

export function AccountSettings(props: Props) {
  return (
    <section className="account-settings" aria-labelledby="settings-title">
      <h1 id="settings-title">{ACCOUNT_SECTION_TITLES[props.section]}</h1>
      <Section {...props} />
    </section>
  );
}
