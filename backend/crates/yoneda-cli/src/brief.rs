//! `yoneda status` in a Git clone with a yoneda remote (`--brief`: one line, local data
//! only, for session hooks): which repository, and how many local commits on the current
//! branch the platform does not have yet.
use crate::error::{Error, Result};
use crate::remote::map::CommitMap;
use crate::target::Clone;

/// First-parent commits checked for the newest one the platform has.
const WALK: &str = "200";

pub fn line(clone: &Clone) -> Result<String> {
    let remote = clone
        .remote
        .as_ref()
        .ok_or_else(|| Error::new("this clone has no yoneda remote"))?;
    let map = CommitMap::open(&clone.git_dir, &remote.repo)?;
    let branch = clone
        .git
        .run(&["symbolic-ref", "--short", "HEAD"])
        .unwrap_or_else(|_| "HEAD".into());
    let listed = clone
        .git
        .run(&["rev-list", "--first-parent", "--max-count", WALK, "HEAD"])
        .unwrap_or_default();
    let unpushed = listed
        .lines()
        .position(|c| map.server(c).is_some())
        .map_or_else(|| format!("{WALK}+"), |n| n.to_string());
    let conflict = crate::remote::conflict_file(&clone.git_dir, &remote.repo).exists();
    Ok(format!(
        "yoneda {} at {} | {branch}: {unpushed} commit(s) not on the platform{}",
        remote.repo,
        remote.origin,
        if conflict {
            " | last landing refused (yoneda conflicts)"
        } else {
            ""
        }
    ))
}
