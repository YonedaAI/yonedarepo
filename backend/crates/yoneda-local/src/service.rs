//! One running repository: its authority, its object store and the two host-side locks
//! (landing on a protected branch, projecting refs) that keep the host's own multi-step
//! sequences from interleaving. The rules themselves are the authority's.
use crate::authority::{Authority, Cred};
use crate::layout::{Config, Layout};
use crate::store::Store;
use crate::sync::Kick;
use crate::timing::Timings;
use std::sync::{Mutex, mpsc};
use tokio::sync::watch;
use yoneda_core::Result;

pub struct Service {
    pub authority: Authority,
    pub store: Store,
    pub config: Config,
    pub layout: Layout,
    /// Held from a protected branch's first landing attempt to its last, so a merge built
    /// against the head is landed before anyone else moves it.
    pub landing: Mutex<()>,
    pub projecting: Mutex<()>,
    /// `main`'s log version after each landing on it: the seam cloud sync subscribes to.
    pub main_landed: watch::Sender<u64>,
    /// The running sync thread, told of each landing on `main` (none outside `serve`).
    pub sync: Mutex<Option<mpsc::Sender<Kick>>>,
    /// Per-push timings, when switched on (`timing`).
    pub timings: Timings,
}

/// The ref projector's platform role (`repo_refs`, `repo_commit`: read).
pub const PROJECTOR: Cred = Cred::System("projection");

impl Service {
    pub fn open(layout: &Layout) -> Result<Self> {
        let config = layout.config()?;
        Ok(Self {
            authority: Authority::open(&layout.authority())?,
            store: Store::at(&layout.store()),
            config,
            layout: layout.clone(),
            landing: Mutex::new(()),
            projecting: Mutex::new(()),
            main_landed: watch::channel(0).0,
            sync: Mutex::new(None),
            timings: Timings::from_env(),
        })
    }

    /// Tells subscribers `main` landed at `version`.
    pub fn landed_on_main(&self, version: u64) {
        self.main_landed.send_replace(version);
        if let Some(kicks) = self.sync.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = kicks.send(Kick::Landed);
        }
    }
}
