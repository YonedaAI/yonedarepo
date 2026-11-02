//! `--json` results of the SSH key commands and `ssh setup`.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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

/// `ssh setup`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SshSetup {
    /// The `.pub` file used.
    pub key_path: String,
    /// That file's line (never the private key).
    pub public_key: String,
    /// Whether this run generated the key.
    pub generated: bool,
    pub fingerprint: String,
    /// Whether the account already had the key.
    pub already_added: bool,
    pub ssh_host: String,
    /// The cloudflared the config runs; null when none was found or none is needed.
    pub cloudflared: Option<String>,
    /// The SSH config holding the block; null on a front door that needs no entry.
    pub config_path: Option<String>,
    /// Whether this run changed that file.
    pub config_changed: bool,
    /// The tool that took the public key, or null when it was not copied.
    pub clipboard: Option<String>,
    /// Whether `ssh -T` got the platform's greeting; null when it did not run.
    pub check_passed: Option<bool>,
    /// What `ssh -T` said.
    pub check_output: Option<String>,
    /// A whole `git clone` command.
    pub clone: String,
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
    SshKeyAdd => "ssh-key-add",
    SshSetup => "ssh-setup",
    SshKeyList => "ssh-key-list",
    SshKeyRemove => "ssh-key-remove",
}
