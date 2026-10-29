//! The adapter's side of each operation, played as `cloudflare/worker` plays it: commits
//! on a branch's tip, reverts through `replay_changes`, platform merge commits through
//! `merge_trees` and `repo_land` with `merge`, and rebases through `repo_rebase_plan`.
use super::{Driver, Seen, answer, done, leak};
use crate::repo_store::tests::*;
use yoneda_refmodel::{Access, Caller, MAIN, Plan};

const MERGER: &str = "platform:merge";

impl Driver {
    /// Commits `changes` on `branch`'s tip at the current version and lands it there.
    pub(super) fn commit_on(&self, branch: &str, changes: Value, reads: Value) -> Seen {
        let parent = self.ids[self.model.refs[branch]].clone();
        let version = self.model.version;
        match self.h.commit(OWNER, Some(&parent), version, changes, reads) {
            Err(e) => Seen::Refused(e.code),
            Ok(id) => match answer(
                self.h
                    .run(OWNER, json!({"op":"repo_land","ref":branch,"commit":id})),
            ) {
                Seen::Moved => Seen::Committed(id),
                other => other,
            },
        }
    }

    /// Tree `id` as the entries compute asks the adapter for.
    fn listing(&self, id: &str) -> Value {
        let objects = self.h.objects.borrow();
        let entries = decode_tree(&objects[id].1).unwrap_or_default();
        json!(
            entries
                .iter()
                .map(|e| json!({"name": e.name, "id": e.id,
            "type": if e.mode == FileMode::Tree { "tree" } else { "blob" }}))
                .collect::<Vec<_>>()
        )
    }

    /// Runs compute `command` to its answer, supplying the trees and blobs it asks for.
    fn compute(&self, command: Value) -> Value {
        let (mut trees, mut blobs) = (serde_json::Map::new(), serde_json::Map::new());
        loop {
            let mut asked = command.clone();
            asked["trees"] = json!(trees);
            asked["blobs"] = json!(blobs);
            let step = crate::platform_compute(asked).unwrap();
            if let Some(need) = step["need_trees"].as_array() {
                for id in need.iter().filter_map(Value::as_str) {
                    trees.insert(id.into(), self.listing(id));
                }
            } else if let Some(need) = step["need_blobs"].as_array() {
                for id in need.iter().filter_map(Value::as_str) {
                    let data = STANDARD.encode(&self.h.objects.borrow()[id].1);
                    blobs.insert(id.into(), json!(data));
                }
            } else {
                return step;
            }
        }
    }

    /// `replay_changes` reverting `old` -> `new` (tree ids).
    pub(super) fn replay(&self, old: &Value, new: &Value) -> Value {
        self.compute(json!({"op":"replay_changes","direction":"revert","old":old,"new":new}))
            ["changes"]
            .clone()
    }

    fn merge(&self, base: &Value, ours: &Value, theirs: &Value) -> Value {
        self.compute(json!({"op":"merge_trees","base":base,"ours":ours,"theirs":theirs}))
    }

    fn tree_of(&self, commit: &Value) -> Value {
        self.h
            .ok(OWNER, json!({"op":"repo_commit","commit":commit}))["tree"]
            .clone()
    }

    /// `repo_merge_plan` for landing `commit` on main.
    pub(super) fn plan(&self, commit: &Value) -> Plan {
        let plan = self.h.ok(
            OWNER,
            json!({"op":"repo_merge_plan","ref":MAIN,"commit":commit}),
        );
        Plan {
            kind: leak(plan["outcome"].as_str().unwrap_or_default()),
            paths: serde_json::from_value(plan["paths"].clone()).unwrap_or_default(),
        }
    }

    /// Lands `commit` on main; when a merge is required, merges it into the head from the
    /// plan's base, commits the merge as the platform merger and lands it with `merge`.
    pub(super) fn merge_land(&self, commit: &Value) -> Seen {
        let land = |merge: Option<&str>| {
            self.h.run(
                OWNER,
                json!({"op":"repo_land","ref":MAIN,"commit":commit,"merge":merge}),
            )
        };
        match land(None) {
            Err(e) if e.code == "MERGE_REQUIRED" => {}
            other => return answer(other),
        }
        let plan = self.h.ok(
            OWNER,
            json!({"op":"repo_merge_plan","ref":MAIN,"commit":commit}),
        );
        let merged = self.merge(&plan["base_tree"], &plan["head_tree"], &plan["commit_tree"]);
        if merged["conflicts"]
            .as_array()
            .is_some_and(|c| !c.is_empty())
        {
            return Seen::Refused("CONFLICT".into());
        }
        let head = plan["head"].as_str().unwrap_or_default();
        let made = self.h.commit_with(
            MERGER,
            Some(head),
            self.model.version,
            merged["changes"].clone(),
            json!([]),
            json!({"merge_parent": commit}),
        );
        let id = match made {
            Err(e) => return Seen::Refused(e.code),
            Ok(id) => id,
        };
        match answer(land(Some(&id))) {
            Seen::Moved => Seen::Committed(id),
            other => other,
        }
    }

    /// `git rebase main <branch>` on the server, as `repo-rebase.ts` runs it.
    pub(super) fn rebase(&self, branch: &str) -> Seen {
        let plan = match self.h.run(
            OWNER,
            json!({"op":"repo_rebase_plan","ref":branch,"onto":"main"}),
        ) {
            Err(e) => return Seen::Refused(e.code),
            Ok(plan) => plan,
        };
        if plan["up_to_date"] == true {
            return Seen::Already;
        }
        let version = plan["version"].as_u64().unwrap_or_default();
        let mut head = plan["onto_head"].clone();
        let mut tree = plan["onto_tree"].clone();
        let mut made = Vec::new();
        for item in plan["commits"].as_array().into_iter().flatten() {
            let merged = self.merge(&item["parent_tree"], &tree, &item["tree"]);
            if merged["conflicts"]
                .as_array()
                .is_some_and(|c| !c.is_empty())
            {
                return Seen::Refused("CONFLICT".into());
            }
            let changes = merged["changes"].clone();
            if changes.as_array().is_none_or(Vec::is_empty) {
                continue;
            }
            let parent = head.as_str().unwrap_or_default().to_owned();
            match self
                .h
                .commit(OWNER, Some(&parent), version, changes, json!([]))
            {
                Err(e) => return Seen::Refused(e.code),
                Ok(id) => {
                    head = json!(id);
                    tree = self.tree_of(&head);
                    made.push(id);
                }
            }
        }
        let moved = self.h.run(
            OWNER,
            json!({"op":"repo_branch_set","ref":branch,"commit":head,"expected":plan["head"]}),
        );
        match answer(moved) {
            Seen::Moved => Seen::Rebased(made),
            other => other,
        }
    }

    /// Runs `command` with `caller`'s credentials, as the adapter forwards them.
    pub(super) fn as_caller(
        &self,
        caller: &Caller,
        mut command: Value,
    ) -> yoneda_core::Result<Value> {
        *self.h.now.borrow_mut() += 1_000;
        command["now"] = json!(*self.h.now.borrow());
        match caller {
            Caller::Owner => command["_session"] = json!({"workspace": "ws-1", "principal": OWNER}),
            Caller::Anonymous => command["_anonymous"] = json!(true),
            Caller::Account(name) => {
                command["_session"] =
                    json!({"workspace": name, "principal": format!("user:{name}"), "human": true})
            }
        }
        execute_repo_store(&self.h.db, command)
    }

    /// `caller` tries `access`; a reader allowed the refs sees the model's.
    pub(super) fn probe(&self, caller: &Caller, access: Access) -> Seen {
        let command = match access {
            Access::Status => json!({"op":"repo_status"}),
            Access::Refs => json!({"op":"repo_refs"}),
            Access::Log => json!({"op":"repo_log","ref":"main","limit":5}),
            Access::Fetch => json!({"op":"repo_git_access","service":"git-upload-pack"}),
            Access::Push => json!({"op":"repo_git_access","service":"git-receive-pack"}),
        };
        let answered = self.as_caller(caller, command);
        if let Ok(listed) = &answered
            && access == Access::Refs
        {
            let model = &self.model.refs;
            let seen = listed["refs"].as_object().map_or(0, |refs| {
                refs.keys().filter(|name| model.contains_key(*name)).count()
            });
            if seen != model.len() {
                return Seen::Refused(format!("REFS_MISMATCH {listed}"));
            }
        }
        done(answered)
    }
}
