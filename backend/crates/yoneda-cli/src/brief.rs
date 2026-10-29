//! `yoneda status` in a Git clone with a yoneda remote (`--brief`: one line, local data
//! only, for session hooks): which repository, and how many local commits on the current
//! branch the platform does not have yet.
use crate::error::{Error, Result};
use crate::output::Status;
use crate::remote::map::CommitMap;
use crate::target::Clone;

/// First-parent commits checked for the newest one the platform has.
const WALK: usize = 200;

/// A clone's local status.
pub struct Brief {
    repo: String,
    origin: String,
    branch: String,
    /// A count, or `200+`.
    unpushed: String,
    conflict: bool,
}

pub fn line(clone: &Clone) -> Result<String> {
    Ok(Brief::of(clone)?.line())
}

impl Brief {
    pub fn of(clone: &Clone) -> Result<Self> {
        let remote = clone
            .remote
            .as_ref()
            .ok_or_else(|| Error::new("this clone has no yoneda remote"))?;
        let map = CommitMap::open(&clone.git_dir, &remote.repo)?;
        let branch = clone
            .git
            .run(&["symbolic-ref", "--short", "HEAD"])
            .unwrap_or_else(|_| "HEAD".into());
        // Commit ids are the platform's, so what the yoneda remote's tracking refs reach is
        // on the platform; the commit map names the few pushed commits with other ids.
        let walk = WALK.to_string();
        let mut args = vec!["rev-list", "--first-parent", "--max-count", &walk, "HEAD"];
        let tracked = clone
            .remote_name
            .as_ref()
            .map(|name| format!("--remotes={name}"));
        if let Some(tracked) = &tracked {
            args.extend(["--not", tracked]);
        }
        let listed = clone.git.run(&args).unwrap_or_default();
        let unknown: Vec<&str> = listed
            .lines()
            .take_while(|c| map.server(c).is_none())
            .collect();
        let unpushed = if unknown.len() >= WALK {
            format!("{WALK}+")
        } else {
            unknown.len().to_string()
        };
        Ok(Self {
            repo: remote.repo.clone(),
            origin: remote.origin.clone(),
            branch,
            unpushed,
            conflict: crate::remote::conflict_file(&clone.git_dir, &remote.repo).exists(),
        })
    }

    pub fn line(&self) -> String {
        format!(
            "yoneda {} at {} | {}: {} commit(s) not on the platform{}",
            self.repo,
            self.origin,
            self.branch,
            self.unpushed,
            if self.conflict {
                " | last landing refused (yoneda conflicts)"
            } else {
                ""
            }
        )
    }

    pub fn report(self) -> Status {
        Status::Clone {
            repo: self.repo,
            origin: self.origin,
            branch: self.branch,
            unpushed: self.unpushed,
            landing_refused: self.conflict,
        }
    }
}
