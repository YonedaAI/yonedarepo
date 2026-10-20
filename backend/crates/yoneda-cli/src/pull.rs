//! `yoneda pull`: brings the branch's latest version in as a local snapshot commit on
//! the old base and rebases the pending local commits onto it, re-pinning the checkout.
use crate::checkout::Checkout;
use crate::error::{Error, Result};
use crate::snapshot;

pub async fn pull(co: &mut Checkout) -> Result<()> {
    if !co.git.clean()? {
        return Err(Error::new(
            "commit or stash your changes before `yoneda pull`",
        ));
    }
    let branch = co.state.branch.clone();
    let (version, head) = co.api.branch_at_latest(&branch).await?;
    if head == co.state.base_commit {
        // Only other branches moved: the base advances without new content.
        co.state.base_version = co.state.base_version.max(version);
    } else {
        let message = co.snapshot_message(version, &head);
        let old_base = co.state.local_base.clone();
        let local = snapshot::import(&co.api, &co.git, &head, Some(&old_base), &message).await?;
        co.state.rebase(version, &head, &local);
    }
    co.save()?;
    integrate(co, version)
}

/// Puts HEAD on the local base: fast-forward, or rebase the commits made on an older
/// base (also after an aborted rebase, since the snapshot's parent is that older base).
fn integrate(co: &Checkout, version: u64) -> Result<()> {
    let base = co.state.local_base.clone();
    let branch = &co.state.branch;
    let upstream = co.git.run(&["merge-base", "HEAD", &base])?;
    if upstream == base {
        println!("Up to date with {branch} at version {version}");
        return Ok(());
    }
    let range = format!("{upstream}..HEAD");
    let pending = co
        .git
        .run(&["rev-list", "--first-parent", "--count", &range])?;
    if pending == "0" {
        co.fast_forward(&base)?;
        println!("Fast-forwarded to {branch} at version {version}");
        return Ok(());
    }
    if let Err(e) = co.git.run(&["rebase", "-q", "--onto", &base, &upstream]) {
        return Err(Error::new(format!(
            "rebasing {pending} pending commit(s) onto version {version} stopped: {e}\n  \
             resolve the files, `git add` them and `git rebase --continue`, then `yoneda sync`\n  \
             (or `git rebase --abort` and run `yoneda pull` again later)"
        )));
    }
    println!("Rebased {pending} pending commit(s) onto {branch} at version {version}");
    Ok(())
}
