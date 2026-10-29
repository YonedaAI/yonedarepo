//! `--json` results of the account commands: repositories, organizations and SSH keys.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Who may read a repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    /// Anyone, signed in or not.
    Public,
    /// Its owner and members.
    Private,
}

impl Visibility {
    pub fn of(public: bool) -> Self {
        if public { Self::Public } else { Self::Private }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Private => "private",
        }
    }
}

/// `repo create`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepoCreate {
    pub id: String,
    pub name: String,
    pub visibility: Visibility,
    /// The organization that owns it (`--owner`), else the caller's account.
    pub owner: Option<String>,
    /// The URL to `git clone` (`yoneda::<origin>/<id>`).
    pub remote: String,
}

/// One repository the caller can read.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepoListed {
    pub id: String,
    pub name: String,
    /// `public` or `private`.
    pub visibility: String,
    /// When it was created, as the platform lists it (Unix milliseconds).
    pub created_at: Value,
}

/// `repo list`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepoList {
    pub repos: Vec<RepoListed>,
}

/// `repo visibility`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepoVisibility {
    pub id: String,
    pub visibility: Visibility,
}

/// `repo delete`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepoDelete {
    pub id: String,
    /// The name given to `--confirm`.
    pub name: String,
}

/// `repo import`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepoImport {
    pub id: String,
    pub name: String,
    /// Files imported (landed on main).
    pub files: u64,
    /// The URL to `git clone`.
    pub remote: String,
}

/// `repo fork`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepoFork {
    /// The repository forked.
    pub parent: String,
    /// The new fork's id.
    pub id: String,
    pub name: String,
    /// The parent's log version the fork copies.
    pub parent_version: Option<u64>,
    pub refs: Option<u64>,
    pub commits: Option<u64>,
    /// The URL to `git clone` the fork.
    pub remote: String,
}

/// An organization and the caller's role in it.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgMembership {
    pub org: String,
    pub role: String,
}

/// `org list`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgList {
    pub orgs: Vec<OrgMembership>,
}

/// `org create` (the caller becomes its owner).
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgCreate {
    pub org: String,
}

/// `org delete` (the name is retired for good).
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgDelete {
    pub org: String,
}

/// A team and its members.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgTeam {
    pub name: String,
    pub members: Vec<String>,
}

/// An organization member.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgMember {
    pub account: String,
    pub role: String,
}

/// `org show`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgShow {
    pub org: String,
    /// The caller's role.
    pub role: String,
    pub created_by: String,
    pub members: Vec<OrgMember>,
    pub teams: Vec<OrgTeam>,
}

/// A repository an organization owns.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgRepo {
    pub id: String,
    pub name: String,
}

/// `org repos`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgRepos {
    pub org: String,
    pub repos: Vec<OrgRepo>,
}

/// `org member add`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgMemberAdd {
    pub org: String,
    pub account: String,
    pub role: String,
}

/// `org member remove` (also from the organization's teams).
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgMemberRemove {
    pub org: String,
    pub account: String,
}

/// `org team create`; a repository grants it as `team:<org>/<team>`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgTeamCreate {
    pub org: String,
    pub team: String,
}

/// `org team delete`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgTeamDelete {
    pub org: String,
    pub team: String,
}

/// `org team add`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgTeamAdd {
    pub org: String,
    pub team: String,
    pub account: String,
}

/// `org team remove`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OrgTeamRemove {
    pub org: String,
    pub team: String,
    pub account: String,
}

/// An SSH public key on the account.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SshKey {
    pub id: String,
    pub fingerprint: String,
    pub title: String,
    /// Last Git over SSH use (Unix milliseconds), or null.
    pub last_used_at: Option<i64>,
}

/// `ssh-key add`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SshKeyAdd {
    pub id: String,
    pub fingerprint: String,
    pub title: String,
    /// The SSH host to clone from; null while Git over SSH is not open.
    pub ssh_host: Option<String>,
    /// The `~/.ssh/config` entry the host needs (Cloudflare Tunnel), if any.
    pub ssh_config: Option<String>,
}

/// `ssh-key list`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SshKeyList {
    pub keys: Vec<SshKey>,
}

/// `ssh-key remove`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SshKeyRemove {
    pub id: String,
}

super::report! {
    RepoCreate => "repo-create",
    RepoList => "repo-list",
    RepoVisibility => "repo-visibility",
    RepoDelete => "repo-delete",
    RepoImport => "repo-import",
    RepoFork => "repo-fork",
    OrgList => "org-list",
    OrgCreate => "org-create",
    OrgShow => "org-show",
    OrgRepos => "org-repos",
    OrgDelete => "org-delete",
    OrgMemberAdd => "org-member-add",
    OrgMemberRemove => "org-member-remove",
    OrgTeamCreate => "org-team-create",
    OrgTeamDelete => "org-team-delete",
    OrgTeamAdd => "org-team-add",
    OrgTeamRemove => "org-team-remove",
    SshKeyAdd => "ssh-key-add",
    SshKeyList => "ssh-key-list",
    SshKeyRemove => "ssh-key-remove",
}
