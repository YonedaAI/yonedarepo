//! What sync knows, in `.git/yoneda/local/sync.json` (owner-only, replaced atomically).
//! Everything here can be rebuilt from the cloud and the local log, except the pairing
//! (origin and repository id), which is written before anything is pushed so a retried
//! pairing never creates a second cloud repository.
use crate::layout::{Layout, write_private};
use serde::{Deserialize, Serialize};
use yoneda_core::Result;

/// Where sync stands, worst first: what the person must act on comes before what clears
/// itself.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    #[default]
    Synced,
    /// Local landings not yet on the cloud (or a round not run yet).
    Pending,
    /// Cloud the integration branch moved in a way that conflicts with local the integration branch; local the integration branch is kept.
    Diverged,
    /// The cloud refused local the integration branch as a conflict; the cloud is left as it was.
    Conflict,
    /// The cloud could not be reached; local work keeps landing.
    Offline,
    /// The cloud refused the credential (or there is none): sign in again.
    Refused,
    /// No cloud repository yet: no yoneda remote and no stored login to create one with.
    Unpaired,
    /// Publication is explicitly disabled for this clone.
    Disabled,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Sync {
    /// The cloud origin, `scheme://host[:port]`.
    pub origin: Option<String>,
    /// The name a cloud repository is created with (the clone's directory name).
    pub name: Option<String>,
    /// The cloud repository id (the local one matches it once paired).
    pub repo: Option<String>,
    /// Whether the integration branch's history has reached the cloud repository.
    pub paired: bool,
    pub state: State,
    /// Why, in the platform's or Git's words.
    pub detail: Option<String>,
    /// Cloud the integration branch as last seen.
    pub cloud_main: Option<String>,
    /// The local log version up to which local the integration branch is on the cloud.
    pub synced_version: u64,
    /// When the last round finished (ms since the epoch).
    pub last_round_ms: Option<u64>,
}

impl Sync {
    pub fn load(layout: &Layout) -> Self {
        std::fs::read_to_string(layout.sync())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, layout: &Layout) -> Result<()> {
        let text = serde_json::to_vec_pretty(self).unwrap_or_default();
        write_private(&layout.sync(), &text)
    }

    /// Records an outcome of this round, keeping the worst one.
    pub fn note(&mut self, state: State, detail: impl Into<String>) {
        if state >= self.state {
            self.state = state;
            self.detail = Some(detail.into());
        }
    }
}
