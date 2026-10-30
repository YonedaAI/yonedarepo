// Account settings, one page per section (`settingsRoute.ts`; the sidebar's Account group moves
// between them): General (the profile, its email, its connected accounts, the theme, a way to
// Billing), Billing, Tokens, SSH keys and Organizations. Each page is its title (Organizations
// adds a description and Create organization), then headed cards of rows.
import { SettingsRow, SettingsSection } from '../../components/SettingsSection';
import type { AccountIdentity } from '../../lib/types';
import { ThemePicker } from '../shell/ThemePicker';
import { linkTo, type Navigate } from '../shell/useRoute';
import { AccountOrgs, CreateOrganization } from '../source-platform/AccountOrgs';
import type { OrgSummary } from '../source-platform/orgModel';
import { Loading } from '../source-platform/SourceStatus';
import { SshKeys } from '../source-platform/SshKeys';
import type { RepoSummary } from '../source-platform/TokenParts';
import type { Loaded } from '../source-platform/useSource';
import { AvatarSettings } from './AvatarSettings';
import { BillingSettings } from './BillingSettings';
import { EmailSettings } from './EmailSettings';
import { SignInMethods } from './SignInMethods';
import { ACCOUNT_SECTION_TITLES, type AccountSection, formatSettingsRoute } from './settingsRoute';
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

const BILLING = { view: 'settings', section: 'billing' } as const;

/** Waiting for the session, or nobody signed in. */
const NoAccount = ({ loading }: { loading?: boolean }) =>
  loading ? <Loading what="your account" /> : <p className="source-meta">Sign in to see it.</p>;

function General({ identity, loading, onAvatar, navigate }: Props) {
  return (
    <>
      <SettingsSection id="profile" title="Profile">
        {identity ? (
          <AvatarSettings identity={identity} onChange={onAvatar} />
        ) : (
          <div className="settings-block">
            <NoAccount loading={loading} />
          </div>
        )}
      </SettingsSection>
      {identity && <EmailSettings />}
      {identity && <SignInMethods />}
      <SettingsSection id="appearance" title="Appearance">
        <SettingsRow
          title="Theme"
          detail="System follows your device. Kept in this browser."
          action={<ThemePicker />}
        />
      </SettingsSection>
      {identity && (
        <SettingsSection id="general-billing" title="Billing">
          <SettingsRow
            title="Agent credit and usage"
            detail="Platform features are free. Managed agent runs use credit."
            action={
              <a
                className="button-link quiet"
                {...(navigate ? linkTo(BILLING, navigate) : { href: formatSettingsRoute(BILLING) })}
              >
                Manage billing
              </a>
            }
          />
        </SettingsSection>
      )}
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
  const { section, identity, orgs, navigate } = props;
  const isOrgs = section === 'organizations';
  return (
    <section className="account-settings" aria-labelledby="settings-title">
      <header className="settings-head">
        <div>
          <h1 id="settings-title">{ACCOUNT_SECTION_TITLES[section]}</h1>
          {isOrgs && (
            <p className="source-meta">
              Organizations own repositories together, with members and teams.
            </p>
          )}
        </div>
        {isOrgs && identity && orgs && navigate && (
          <CreateOrganization orgs={orgs} navigate={navigate} />
        )}
      </header>
      <Section {...props} />
    </section>
  );
}
