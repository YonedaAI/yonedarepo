//! Pairing: each local repository has a cloud repository. A clone made from YonedaRepo is
//! paired with its own (`init` records it). Otherwise sync creates one on the stored
//! login's origin, records its id before pushing anything (so a retry never creates a
//! second), pushes `main`'s history to it, and then gives the local repository the cloud
//! repository's id: the remote `local` and the service's URL follow.
use super::state::{State, Sync};
use super::{classify, local_main, main_version};
use crate::cloud::{self, Cloud};
use crate::layout::{Layout, local_error};
use crate::service::Service;
use crate::store::run_in;
use yoneda_core::Result;

/// Pairs the repository if it is not yet. Answers the cloud once its history is there.
pub fn pair(svc: &Service, layout: &Layout, sync: &mut Sync) -> Result<Option<Cloud>> {
    if sync.origin.is_none() {
        let Some(origin) = cloud::account_origin() else {
            sync.note(
                State::Unpaired,
                "no cloud repository: sign in with `yoneda login`, then run `yoneda local sync`",
            );
            return Ok(None);
        };
        sync.origin = Some(origin);
    }
    let origin = sync.origin.clone().unwrap_or_default();
    if sync.repo.is_none() {
        let Some(token) = cloud::token_for(&origin) else {
            sync.note(
                State::Unpaired,
                format!("no login for {origin}: run `yoneda login`, then `yoneda local sync`"),
            );
            return Ok(None);
        };
        let name = sync.name.clone().unwrap_or_else(|| "local".into());
        match cloud::create_repo(&origin, &token, &name) {
            Ok(id) => {
                sync.repo = Some(id);
                sync.save(layout)?;
            }
            Err(e) => {
                let state = if e.message.contains("(401") || e.message.contains("(403") {
                    State::Refused
                } else if e.message.contains("Cannot reach") {
                    State::Offline
                } else {
                    State::Pending
                };
                sync.note(state, e.message);
                return Ok(None);
            }
        }
    }
    let target = Cloud {
        origin,
        repo: sync.repo.clone().unwrap_or_default(),
    };
    if !sync.paired {
        if let Some(local) = local_main(svc)? {
            let url = target.git_url();
            let refspec = format!("{local}:refs/heads/main");
            let out = cloud::git(
                &layout.store(),
                &target.origin,
                &["push", "--porcelain", &url, &refspec],
            )?;
            if !out.status.success() {
                let (state, why) = classify(&out);
                sync.note(
                    state,
                    format!("pushing main to the new cloud repository: {why}"),
                );
                return Ok(None);
            }
            sync.cloud_main = Some(local.to_string());
        }
        adopt_id(layout, &target.repo)?;
        sync.paired = true;
        sync.synced_version = main_version(svc)?;
        sync.save(layout)?;
    }
    Ok(Some(target))
}

/// The local repository takes the cloud repository's id: its config and the clone's
/// remote `local` (shared by every worktree).
fn adopt_id(layout: &Layout, repo: &str) -> Result<()> {
    let mut config = layout.config()?;
    if config.repo == repo {
        return Ok(());
    }
    config.repo = repo.to_owned();
    layout.write_config(&config)?;
    let common = layout
        .common()
        .ok_or_else(|| local_error("Cannot find the clone's Git directory"))?;
    let git_dir = format!("--git-dir={}", common.display());
    let url = config.url();
    run_in(
        &common,
        &[&git_dir, "remote", "set-url", "local", &url],
        None,
    )
    .or_else(|_| run_in(&common, &[&git_dir, "remote", "add", "local", &url], None))?;
    Ok(())
}
