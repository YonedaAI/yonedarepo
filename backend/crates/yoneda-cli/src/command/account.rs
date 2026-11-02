//! Account-level commands: repositories, organizations, SSH keys and tokens.

/// The shells `yoneda completion` writes a script for.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Shell {
    Bash,
    Zsh,
    Fish,
    Powershell,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RepoCommand {
    Create {
        name: String,
        /// An organization to own it (the caller must be one of its owners).
        owner: Option<String>,
        /// Anyone reads it, signed in or not (default: owner and members only).
        public: bool,
    },
    List,
    /// Makes repository `id` public or private (its owner only).
    Visibility {
        id: String,
        public: bool,
    },
    Delete {
        id: String,
        confirm: String,
    },
    Import {
        dir: String,
        name: Option<String>,
        batch_files: usize,
    },
    /// A fork of repository `id`, owned by the caller's account or organization `owner`.
    Fork {
        id: String,
        name: Option<String>,
        /// An organization to own it (the caller must be one of its owners).
        owner: Option<String>,
    },
    /// Points this project's Git remote `remote` at a repository (`<owner>/<name>` or an id).
    RemoteAdd {
        remote: String,
        repo: String,
        /// Replace a remote that points elsewhere.
        replace: bool,
    },
}

/// `yoneda org …`: organizations, their members and teams.
#[derive(Debug, PartialEq, Eq)]
pub enum OrgCommand {
    List,
    Create {
        name: String,
    },
    Show {
        org: String,
    },
    Repos {
        org: String,
    },
    Delete {
        org: String,
        confirm: String,
    },
    MemberAdd {
        org: String,
        account: String,
        role: String,
    },
    MemberRemove {
        org: String,
        account: String,
    },
    TeamCreate {
        org: String,
        team: String,
    },
    TeamDelete {
        org: String,
        team: String,
    },
    TeamAdd {
        org: String,
        team: String,
        account: String,
    },
    TeamRemove {
        org: String,
        team: String,
        account: String,
    },
}

/// `yoneda ssh-key …`: the account's SSH public keys (Git over SSH).
#[derive(Debug, PartialEq, Eq)]
pub enum SshKeyCommand {
    /// A public key read from `source` (a path, or `-` for stdin).
    Add {
        source: String,
        title: Option<String>,
    },
    List,
    Remove {
        id: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenCommand {
    Create {
        name: String,
        scopes: Vec<String>,
        paths: Option<Vec<String>>,
    },
    List,
    Revoke {
        name: String,
    },
}
