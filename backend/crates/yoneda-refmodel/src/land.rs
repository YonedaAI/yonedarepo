//! Landing: already there, a fast-forward, or the optimistic-concurrency refusal, and the
//! merge plan the platform reports for it.
use crate::{CommitId, MAIN, Outcome, Plan, Repo};
use std::collections::BTreeSet;

pub(crate) enum Occ {
    /// An entry after the base wrote a path the commit read (or moved the ref opaquely).
    Conflict(Vec<String>),
    /// No entry after the base.
    FastForward,
    /// Entries after the base, writing none of the commit's paths.
    Rebase,
    /// Entries after the base writing these of the commit's paths.
    Merge(Vec<String>),
}

impl Repo {
    /// Lands `branch`'s tip on working branch `onto`.
    pub(crate) fn land_onto(&mut self, branch: &str, onto: &str) -> Outcome {
        match (self.tip(branch), self.tip(onto)) {
            (Some(commit), Some(_)) => self.land_on(onto, commit),
            _ => Outcome::Refused("NOT_FOUND"),
        }
    }

    /// Lands `commit` on main.
    pub(crate) fn land(&mut self, commit: CommitId) -> Outcome {
        self.land_on(MAIN, commit)
    }

    /// Lands `commit` on `refname`: a no-op where it is the head or landed there before;
    /// refused while landings are queued there (`busy`); a fast-forward (logging every path the head and the commit differ in) where the head
    /// is its parent or an ancestor; otherwise refused as optimistic concurrency decides.
    pub(crate) fn land_on(&mut self, refname: &str, commit: CommitId) -> Outcome {
        let head = self.tip(refname);
        if head == Some(commit) || self.landings.contains_key(&(commit, refname.to_owned())) {
            return Outcome::Already;
        }
        // While landings are queued on the branch, direct ones join the queue.
        if self.busy(refname) {
            return Outcome::Refused("MERGE_REQUIRED");
        }
        let paths = match head {
            None => self.commits[commit].writes.clone(),
            Some(head)
                if self.commits[commit].parents.first() == Some(&head)
                    || self.is_ancestor(head, commit) =>
            {
                Self::changed(&self.commits[head].tree, &self.commits[commit].tree)
            }
            Some(_) => {
                return Outcome::Refused(match self.occ(commit, refname) {
                    Occ::Conflict(_) => "CONFLICT",
                    Occ::FastForward => "STALE_PARENT",
                    Occ::Rebase | Occ::Merge(_) => "MERGE_REQUIRED",
                });
            }
        };
        self.move_ref(refname, Some(commit), paths, true);
        self.landed(commit, refname.to_owned());
        Outcome::Moved
    }

    /// `repo_merge_plan` for landing `commit` on main (decided whether or not it is on head).
    pub(crate) fn plan(&self, commit: CommitId) -> Plan {
        // Main's Git head is unknown until the projector builds it.
        if !self.unprojected.is_empty() {
            return Plan {
                kind: "PROJECTION_PENDING",
                paths: vec![],
            };
        }
        let head = self.tip(MAIN);
        let (kind, paths) = match self.occ(commit, MAIN) {
            Occ::FastForward if self.commits[commit].parents.first() == head.as_ref() => {
                ("fast_forward", vec![])
            }
            Occ::FastForward => ("stale", vec![]),
            Occ::Rebase => ("rebase", vec![]),
            Occ::Merge(paths) => ("merge", paths),
            Occ::Conflict(paths) => ("conflict", paths),
        };
        Plan { kind, paths }
    }

    /// Main's entries after the commit's base version against what it read and wrote. Paths
    /// here never nest (no file is another's directory), so overlapping means equal.
    /// The version after which `refname`'s landings are concurrent with `commit`: its base
    /// version on a protected branch; on a working branch, its parent's first landing
    /// there when that came earlier (the base version reads main, so it can postdate a
    /// teammate's landing on the branch that the commit does not hold).
    fn since(&self, commit: CommitId, refname: &str) -> u64 {
        let c = &self.commits[commit];
        let landed = c
            .parents
            .first()
            .filter(|_| !Self::protected(refname))
            .and_then(|p| self.landings.get(&(*p, refname.to_owned())));
        landed.map_or(c.base_version, |v| (*v).min(c.base_version))
    }

    pub(crate) fn occ(&self, commit: CommitId, refname: &str) -> Occ {
        let c = &self.commits[commit];
        let since = self.since(commit, refname);
        let later: Vec<_> = self
            .log
            .iter()
            .filter(|e| e.version > since && e.refname == refname)
            .collect();
        for entry in &later {
            let stale: Vec<String> = c.read_set.intersection(&entry.paths).cloned().collect();
            // A ref move without paths cannot be proven independent of what was read.
            let opaque = entry.paths.is_empty() && !entry.landing;
            if opaque || !stale.is_empty() {
                return Occ::Conflict(stale);
            }
        }
        if later.is_empty() {
            return Occ::FastForward;
        }
        let theirs: BTreeSet<&String> = later.iter().flat_map(|e| &e.paths).collect();
        let shared: Vec<String> = c
            .writes
            .iter()
            .filter(|p| theirs.contains(p))
            .cloned()
            .collect();
        if shared.is_empty() {
            Occ::Rebase
        } else {
            Occ::Merge(shared)
        }
    }
}
