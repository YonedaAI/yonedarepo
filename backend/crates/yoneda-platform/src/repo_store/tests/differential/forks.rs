//! The fork's side, played as `repo-forks.ts` plays it: the fork job, commits on the
//! fork's `feature`, and carrying it into the parent's mirror branch.
use super::super::forks::{FORK_ID, FORKER, fork};
use super::{Driver, Seen, answer};
use crate::repo_store::tests::*;
use std::collections::BTreeMap;
use yoneda_refmodel::{FEATURE, MAIN};

impl Driver {
    pub(super) fn fork_repo(&self) -> Seen {
        if self.fork.borrow().is_some() {
            return Seen::Already;
        }
        if let Err(e) = self
            .h
            .run(super::super::AGENT, json!({"op":"repo_fork_source"}))
        {
            return Seen::Refused(e.code);
        }
        *self.fork.borrow_mut() = Some(fork(&self.h));
        Seen::Done
    }

    /// A one-file commit on the fork's `feature` (made from its main when absent).
    pub(super) fn fork_commit(&self, path: &str, content: &str) -> Seen {
        let fork = self.fork.borrow();
        let Some(f) = fork.as_ref() else {
            return Seen::Refused("NOT_FOUND".into());
        };
        let refs = match f.run(OWNER, json!({"op":"repo_refs"})) {
            Err(e) => return Seen::Refused(e.code),
            Ok(refs) => refs,
        };
        let mut parent = refs["refs"][FEATURE].clone();
        if parent.is_null() {
            parent = refs["refs"][MAIN].clone();
            let made =
                json!({"op":"repo_branch_set","ref":FEATURE,"commit":parent,"expected":null});
            if let Err(e) = f.run(OWNER, made) {
                return Seen::Refused(e.code);
            }
        }
        let version = f.ok(OWNER, json!({"op":"repo_refs"}))["version"]
            .as_u64()
            .unwrap_or_default();
        let parent = parent.as_str().unwrap_or_default().to_owned();
        let change = json!([file(path, content)]);
        match f.commit(OWNER, Some(&parent), version, change, json!([])) {
            Err(e) => Seen::Refused(e.code),
            Ok(id) => {
                match answer(f.run(OWNER, json!({"op":"repo_land","ref":FEATURE,"commit":id}))) {
                    Seen::Moved => {
                        // Checking its files reads the parent's object double; the fork's
                        // objects join it there (the parent's authority knows none).
                        self.share_objects(f);
                        Seen::Committed(id)
                    }
                    other => other,
                }
            }
        }
    }

    /// `carryForkBranch`: the commits the parent lacks, recorded there as pushed (their
    /// objects copied into its store first), then the mirror branch moved.
    pub(super) fn carry(&self) -> Seen {
        let fork = self.fork.borrow();
        let Some(f) = fork.as_ref() else {
            return Seen::Refused("NOT_FOUND".into());
        };
        let refs = match self.h.run(OWNER, json!({"op":"repo_refs"})) {
            Err(e) => return Seen::Refused(e.code),
            Ok(refs) => refs,
        };
        let tips: Vec<Value> = refs["refs"]
            .as_object()
            .map(|refs| refs.values().cloned().collect())
            .unwrap_or_default();
        let carried = match f.run(
            FORKER,
            json!({"op":"repo_fork_branch","branch":"feature","haves":tips}),
        ) {
            Err(e) => return Seen::Refused(e.code),
            Ok(carried) => carried,
        };
        let fresh: Vec<&Value> = carried["commits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| {
                self.h
                    .run(OWNER, json!({"op":"repo_commit","commit":c["commit"]}))
                    .is_err()
            })
            .collect();
        if !fresh.is_empty() {
            self.share_objects(f);
            let pushed: Vec<Value> = fresh
                .iter()
                .map(|c| {
                    let id = c["commit"].as_str().unwrap_or_default();
                    let data = STANDARD.encode(&f.objects.borrow()[id].1);
                    json!({"commit": id, "data_b64": data, "touches": c["touches"],
                        "objects": [{"id": id, "kind": "commit"}], "check": false})
                })
                .collect();
            if let Err(e) = self
                .h
                .run(FORKER, json!({"op":"repo_record_pushed","commits":pushed}))
            {
                return Seen::Refused(e.code);
            }
        }
        let mirror = json!({"op":"repo_fork_mirror","fork":FORK_ID,"branch":"feature","commit":carried["head"]});
        answer(self.h.run(FORKER, mirror))
    }

    /// The fork's owner deletes it, then the parent forgets it, as `deleteRepository` does.
    pub(super) fn delete_fork(&self) -> Seen {
        let fork = self.fork.borrow();
        let Some(f) = fork.as_ref() else {
            return Seen::Refused("NOT_FOUND".into());
        };
        let deleted = match f.run(OWNER, json!({"op":"repo_delete","confirm":"demo-fork"})) {
            Err(e) => return Seen::Refused(e.code),
            Ok(deleted) => deleted,
        };
        if deleted["parent"].is_string()
            && let Err(e) = self
                .h
                .run(FORKER, json!({"op":"repo_fork_forget","fork":FORK_ID}))
        {
            return Seen::Refused(e.code);
        }
        if deleted["already"] == true {
            Seen::Already
        } else {
            Seen::Done
        }
    }

    /// Copies the fork's objects into the parent's object double, as a carry copies them
    /// into the parent's store of record.
    fn share_objects(&self, fork: &Harness) {
        let mut added = Vec::new();
        for (id, object) in fork.objects.borrow().iter() {
            if !self.h.objects.borrow().contains_key(id) {
                self.h
                    .objects
                    .borrow_mut()
                    .insert(id.clone(), object.clone());
                added.push(id.clone());
            }
        }
        self.remember_trees(added.into_iter());
    }

    /// The fork's branches and tags and version are the model's fork's.
    pub(super) fn same_fork(&self) -> std::result::Result<(), String> {
        let (fork, model) = (self.fork.borrow(), &self.model.fork);
        let (Some(f), Some(m)) = (fork.as_ref(), model) else {
            return match (fork.is_some(), model.is_some()) {
                (false, false) => Ok(()),
                _ => Err("one side has a fork, the other not".into()),
            };
        };
        let listed = match f.run(OWNER, json!({"op":"repo_refs"})) {
            Err(e) if e.code == "GONE" && m.deleted => return Ok(()),
            Err(e) => return Err(format!("fork repo_refs: {e}")),
            Ok(_) if m.deleted => return Err("the fork answers, the model deleted it".into()),
            Ok(listed) => listed,
        };
        let refs: BTreeMap<String, String> = listed["refs"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, id)| (name.clone(), id.as_str().unwrap_or_default().to_owned()))
            .collect();
        let expected: BTreeMap<String, String> = m
            .refs
            .iter()
            .map(|(name, id)| (name.clone(), self.ids[*id].clone()))
            .collect();
        if refs != expected || listed["version"] != m.version {
            let version = &listed["version"];
            return Err(format!(
                "fork: platform {refs:?} at {version}, model {expected:?} at {}",
                m.version
            ));
        }
        Ok(())
    }
}
