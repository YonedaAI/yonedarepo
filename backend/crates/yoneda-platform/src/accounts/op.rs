//! The account authority's commands, by family. Each family's handler matches its own enum.
use crate::ops::op_names;
use crate::storage::string;
use serde::Deserialize;
use serde_json::Value;
use yoneda_core::{Error, Result};

op_names! {
    pub(crate) enum SigninOp {
        Signup = "signup",
        Login = "login",
        Session = "session",
        Logout = "logout",
        Recover = "recover",
        AccountExists = "account_exists",
        WelcomeState = "welcome_state",
        WelcomeSent = "welcome_sent",
    }
}
op_names! {
    /// The contact email's verification (tokens, the change, the confirmation).
    pub(crate) enum EmailOp {
        Status = "email_status",
        Token = "email_token",
        Change = "email_change",
        Verify = "email_verify",
    }
}
op_names! {
    pub(crate) enum TokenOp {
        Create = "pat_create",
        List = "pat_list",
        Check = "pat_check",
        Revoke = "pat_revoke",
    }
}
op_names! {
    pub(crate) enum SshOp {
        KeyAdd = "ssh_key_add",
        KeyList = "ssh_key_list",
        KeyCheck = "ssh_key_check",
        KeyRemove = "ssh_key_remove",
        FpClaim = "ssh_fp_claim",
        FpGet = "ssh_fp_get",
        FpRelease = "ssh_fp_release",
    }
}
op_names! {
    pub(crate) enum DeviceOp {
        Create = "device_create",
        Approve = "device_approve",
        Poll = "device_poll",
    }
}
op_names! {
    /// Sign-in provider identities on the account that holds them.
    pub(crate) enum IdentityOp {
        Signup = "identity_signup",
        Signin = "identity_signin",
        Link = "identity_link",
        List = "identity_list",
        Unlink = "identity_unlink",
        Check = "identity_check",
    }
}
op_names! {
    /// OAuth sign-in attempts and identity claims, each on its own authority instance.
    pub(crate) enum OAuthOp {
        FlowPut = "oauth_flow_put",
        FlowTake = "oauth_flow_take",
        Claim = "identity_claim",
        ClaimGet = "identity_claim_get",
        ClaimRelease = "identity_claim_release",
    }
}
op_names! {
    /// Organization commands any caller may send (each checks what it needs).
    pub(crate) enum OrgOp {
        Create = "org_create",
        Access = "org_access",
        TeamExists = "team_exists",
        HintAdd = "org_hint_add",
        HintRemove = "org_hint_remove",
    }
}
op_names! {
    /// Organization commands for its members: showing it, or managing it as an owner.
    pub(crate) enum OrgMemberOp {
        Show = "org_show",
        Delete = "org_delete",
        MemberPut = "org_member_put",
        MemberRemove = "org_member_remove",
        TeamCreate = "team_create",
        TeamDelete = "team_delete",
        TeamMemberPut = "team_member_put",
        TeamMemberRemove = "team_member_remove",
    }
}

op_names! {
    /// Handles (on a handle's own instance, or the account's) and the repository names an
    /// owner holds.
    pub(crate) enum HandleOp {
        Reserve = "handle_reserve",
        Release = "handle_release",
        Lookup = "handle_lookup",
        Set = "handle_set",
        Get = "handle_get",
        RepoClaim = "owned_repo_claim",
        RepoRelease = "owned_repo_release",
        RepoResolve = "owned_repo_resolve",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub(crate) enum AccountOp {
    Signin(SigninOp),
    Email(EmailOp),
    Token(TokenOp),
    Ssh(SshOp),
    Device(DeviceOp),
    Identity(IdentityOp),
    OAuth(OAuthOp),
    Org(OrgOp),
    OrgMember(OrgMemberOp),
    Handle(HandleOp),
}

impl AccountOp {
    /// The command's `op`; a name no family knows is `NOT_FOUND`.
    pub(crate) fn parse(command: &Value) -> Result<Self> {
        string(command, "op")?;
        Self::deserialize(&command["op"])
            .map_err(|_| Error::new("NOT_FOUND", "Unknown workspace operation"))
    }

    #[cfg(test)]
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Signin(op) => op.name(),
            Self::Email(op) => op.name(),
            Self::Token(op) => op.name(),
            Self::Ssh(op) => op.name(),
            Self::Device(op) => op.name(),
            Self::Identity(op) => op.name(),
            Self::OAuth(op) => op.name(),
            Self::Org(op) => op.name(),
            Self::OrgMember(op) => op.name(),
            Self::Handle(op) => op.name(),
        }
    }

    #[cfg(test)]
    pub(crate) fn all() -> Vec<Self> {
        let mut all: Vec<Self> = SigninOp::ALL.iter().copied().map(Self::Signin).collect();
        all.extend(EmailOp::ALL.iter().copied().map(Self::Email));
        all.extend(TokenOp::ALL.iter().copied().map(Self::Token));
        all.extend(SshOp::ALL.iter().copied().map(Self::Ssh));
        all.extend(DeviceOp::ALL.iter().copied().map(Self::Device));
        all.extend(IdentityOp::ALL.iter().copied().map(Self::Identity));
        all.extend(OAuthOp::ALL.iter().copied().map(Self::OAuth));
        all.extend(OrgOp::ALL.iter().copied().map(Self::Org));
        all.extend(OrgMemberOp::ALL.iter().copied().map(Self::OrgMember));
        all.extend(HandleOp::ALL.iter().copied().map(Self::Handle));
        all
    }
}
