//! Differential tests: seeded random operation sequences run against the reference model
//! (`yoneda-refmodel`, which shares no code with the platform) and the repository authority
//! on its native SQLite store, comparing every outcome, merge plan, ref and version after
//! each step and every new commit's files; at the end of a case, real Git checks the
//! objects, commit graph, trees and merge bases (`git`). A failure names its seed: rerun it
//! with `YONEDA_DIFF_SEED=<seed>`.
use super::batches::open;
use super::*;
use std::collections::BTreeMap;
use yoneda_core::git_object::ObjectId;
use yoneda_refmodel::{CommitId, MAIN, Op, Outcome, Plan, Repo, Rng, Role, Tree, generate};

mod adapter;
mod git;
mod scenarios;

/// What the platform answered for one operation.
#[derive(Debug, PartialEq, Eq)]
enum Seen {
    Committed(String),
    /// The commits a rebase made, and how many replays it dropped as already upstream.
    Rebased(Vec<String>, usize),
    Moved,
    Already,
    Done,
    Refused(String),
}

struct Driver {
    h: Harness,
    model: Repo,
    /// Git id of each model commit, by model number.
    ids: Vec<String>,
    /// Outcomes seen, by operation (`label`).
    tally: BTreeMap<String, usize>,
}

impl Driver {
    fn new() -> Self {
        let (h, root) = open();
        let tree = Tree::from([
            ("README.md".to_owned(), "# demo\n".to_owned()),
            ("src/lib.rs".to_owned(), "pub fn a() {}\n".to_owned()),
        ]);
        Self {
            h,
            model: Repo::seeded(tree),
            ids: vec![root],
            tally: BTreeMap::new(),
        }
    }

    fn git_id(&self, refname: &str) -> Value {
        self.model
            .tip(refname)
            .map_or(Value::Null, |id| json!(self.ids[id]))
    }

    /// Runs `op` on the platform: its outcome, and for a landing its merge plan first.
    fn platform(&self, op: &Op) -> (Seen, Option<Plan>) {
        match op {
            Op::Commit {
                branch,
                path,
                content,
                read,
            } => {
                let change = match content {
                    Some(text) => file(path, text),
                    None => json!({"path": path, "delete": true}),
                };
                let reads = if *read { json!([path]) } else { json!([]) };
                (self.commit_on(branch, json!([change]), reads), None)
            }
            Op::Revert { branch, back } => {
                let tip = self.model.refs[branch];
                let Some(source) = self.model.first_parents(tip).get(*back).copied() else {
                    return (Seen::Refused("NOT_FOUND".into()), None);
                };
                let row = |id: &Value| self.h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
                let source = row(&json!(self.ids[source]));
                let old = row(&source["parents"][0])["tree"].clone();
                (
                    self.commit_on(branch, self.replay(&old, &source["tree"]), json!([])),
                    None,
                )
            }
            Op::CreateBranch { name, from } => (
                answer(self.h.run(
                    OWNER,
                    json!({"op":"repo_branch_set","ref":name,
                    "commit":self.git_id(from),"expected":null}),
                )),
                None,
            ),
            Op::MoveBranch { name, to, expected } => (
                answer(self.h.run(
                    OWNER,
                    json!({"op":"repo_branch_set","ref":name,
                    "commit":self.git_id(to),"expected":self.git_id(expected)}),
                )),
                None,
            ),
            Op::DeleteBranch { name, expected } => (
                answer(self.h.run(
                    OWNER,
                    json!({"op":"repo_branch_batch",
                    "updates":[{"ref":name,"commit":null,"expected":self.git_id(expected)}]}),
                )),
                None,
            ),
            Op::Tag { name, at } => (
                answer(self.h.run(
                    OWNER,
                    json!({"op":"repo_tag_create","name":name,"commit":self.git_id(at)}),
                )),
                None,
            ),
            Op::Land { branch } => {
                let commit = self.git_id(branch);
                let plan = self.plan(&commit);
                let landed = self
                    .h
                    .run(OWNER, json!({"op":"repo_land","ref":MAIN,"commit":commit}));
                (answer(landed), Some(plan))
            }
            Op::MergeLand { branch } => {
                let commit = self.git_id(branch);
                let plan = self.plan(&commit);
                (self.merge_land(&commit), Some(plan))
            }
            Op::Rebase { branch } => (self.rebase(branch), None),
            Op::Probe { caller, access } => (self.probe(caller, *access), None),
            Op::SetVisibility { caller, public } => {
                let visibility = if *public { "public" } else { "private" };
                let set = json!({"op":"repo_set_visibility","visibility":visibility});
                (done(self.as_caller(caller, set)), None)
            }
            Op::Member { account, role } => {
                let command = match role {
                    Some(role) => json!({"op":"repo_member_put","account":account,
                        "role":if *role == Role::Read { "read" } else { "write" }}),
                    None => json!({"op":"repo_member_remove","account":account}),
                };
                (done(self.h.run(OWNER, command)), None)
            }
        }
    }

    /// Applies `op` to both sides and compares what they answer and hold afterwards.
    fn step(&mut self, op: &Op) -> std::result::Result<(), String> {
        let (seen, seen_plan) = self.platform(op);
        let (expected, plan) = self.model.apply(op);
        *self.tally.entry(label(op, &expected)).or_default() += 1;
        if matches!(seen, Seen::Rebased(_, dropped) if dropped > 0) {
            *self.tally.entry("Rebase dropped".into()).or_default() += 1;
        }
        if seen_plan != plan {
            return Err(format!(
                "merge plan: platform {seen_plan:?}, model {plan:?}"
            ));
        }
        match (&seen, &expected) {
            (Seen::Committed(id), Outcome::Committed(model)) if *model == self.ids.len() => {
                self.ids.push(id.clone());
                self.same_files(*model)?;
            }
            (Seen::Rebased(ids, _), Outcome::Rebased(model))
                if model.len() == ids.len()
                    && model
                        .iter()
                        .enumerate()
                        .all(|(i, m)| *m == self.ids.len() + i) =>
            {
                self.ids.extend(ids.iter().cloned());
                for id in model {
                    self.same_files(*id)?;
                }
            }
            (Seen::Moved, Outcome::Moved)
            | (Seen::Already, Outcome::Already)
            | (Seen::Done, Outcome::Done) => {}
            (Seen::Refused(code), Outcome::Refused(model)) if code == model => {}
            _ => return Err(format!("outcome: platform {seen:?}, model {expected:?}")),
        }
        self.same_refs()
    }

    /// The platform's branches and tags and version are the model's.
    fn same_refs(&self) -> std::result::Result<(), String> {
        let listed = self.h.ok(OWNER, json!({"op":"repo_refs"}));
        let refs: BTreeMap<String, String> = listed["refs"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(name, _)| name.starts_with("refs/heads/") || name.starts_with("refs/tags/"))
            .map(|(name, id)| (name.clone(), id.as_str().unwrap_or_default().to_owned()))
            .collect();
        let model: BTreeMap<String, String> = self
            .model
            .refs
            .iter()
            .map(|(name, id)| (name.clone(), self.ids[*id].clone()))
            .collect();
        if refs != model {
            return Err(format!("refs: platform {refs:?}, model {model:?}"));
        }
        if listed["version"] != self.model.version {
            let version = &listed["version"];
            return Err(format!(
                "version: platform {version}, model {}",
                self.model.version
            ));
        }
        Ok(())
    }

    /// The files of model commit `id` are those of its Git commit.
    fn same_files(&self, id: CommitId) -> std::result::Result<(), String> {
        let commit = Commit::decode(&self.h.objects.borrow()[&self.ids[id]].1)
            .and_then(|c| c.tree())
            .map_err(|e| e.message)?;
        let files = self.files(&commit, "");
        if files != self.model.commits[id].tree {
            let model = &self.model.commits[id].tree;
            return Err(format!(
                "files of {}: platform {files:?}, model {model:?}",
                self.ids[id]
            ));
        }
        Ok(())
    }

    fn files(&self, tree: &ObjectId, prefix: &str) -> Tree {
        let objects = self.h.objects.borrow();
        let mut out = Tree::new();
        for entry in decode_tree(&objects[&tree.hex()].1).unwrap_or_default() {
            let path = format!("{prefix}{}", entry.name);
            if entry.mode == FileMode::Tree {
                out.extend(self.files(&entry.id, &format!("{path}/")));
            } else {
                let text = String::from_utf8_lossy(&objects[&entry.id.hex()].1).into_owned();
                out.insert(path, text);
            }
        }
        out
    }
}

/// `Land MERGE_REQUIRED`, `Commit Committed`, ...: an operation's kind and its outcome.
fn label(op: &Op, outcome: &Outcome) -> String {
    let kind = format!("{op:?}");
    let kind = kind.split([' ', '{']).next().unwrap_or_default();
    match outcome {
        Outcome::Committed(_) => format!("{kind} Committed"),
        Outcome::Rebased(_) => format!("{kind} Rebased"),
        Outcome::Refused(code) => format!("{kind} {code}"),
        other => format!("{kind} {other:?}"),
    }
}

/// A ref move's answer: moved, already there, or refused (a batch's stale refs too).
fn answer(result: yoneda_core::Result<Value>) -> Seen {
    match result {
        Err(e) => Seen::Refused(e.code),
        Ok(v) if v["stale"].as_array().is_some_and(|s| !s.is_empty()) => {
            Seen::Refused("STALE_HEAD".into())
        }
        Ok(v) if v["already"] == true || v["refs"][0]["already"] == true => Seen::Already,
        Ok(_) => Seen::Moved,
    }
}

/// An answer that moves no ref: done, or refused.
fn done(result: yoneda_core::Result<Value>) -> Seen {
    match result {
        Err(e) => Seen::Refused(e.code),
        Ok(_) => Seen::Done,
    }
}

/// A plan kind as the model's static names (the platform's set is small and fixed).
fn leak(kind: &str) -> &'static str {
    ["fast_forward", "stale", "rebase", "merge", "conflict"]
        .into_iter()
        .find(|k| *k == kind)
        .unwrap_or("unknown")
}

/// Runs `steps` generated operations from `seed`, then the Git checks; answers the tally.
fn case(seed: u64, steps: usize) -> std::result::Result<BTreeMap<String, usize>, String> {
    let mut rng = Rng::new(seed);
    let mut driver = Driver::new();
    let mut ops = Vec::new();
    for step in 0..steps {
        let op = generate(&mut rng, &driver.model, step);
        ops.push(op.clone());
        driver
            .step(&op)
            .map_err(|e| format!("seed {seed}, step {step}, {op:?}: {e}\nops: {ops:#?}"))?;
    }
    git::check(&driver).map_err(|e| format!("seed {seed}, git: {e}"))?;
    Ok(driver.tally)
}

/// Runs `count` cases (or only `YONEDA_DIFF_SEED`) and answers their outcomes, summed.
fn cases(count: u64, steps: usize) -> BTreeMap<String, usize> {
    let seeds: Vec<u64> = match std::env::var("YONEDA_DIFF_SEED") {
        Ok(seed) => vec![seed.parse().expect("YONEDA_DIFF_SEED is a number")],
        Err(_) => (0..count).collect(),
    };
    let mut tally = BTreeMap::new();
    for seed in seeds {
        for (label, n) in case(seed, steps).unwrap_or_else(|failure| panic!("{failure}")) {
            *tally.entry(label).or_default() += n;
        }
    }
    eprintln!("outcomes: {tally:#?}");
    tally
}

#[test]
fn the_platform_matches_the_reference_model() {
    let tally = cases(16, 80);
    // The generator still reaches every landing outcome and every refusal it aims for
    // (the rarest have scripts of their own: `scenarios`).
    if std::env::var("YONEDA_DIFF_SEED").is_err() {
        for label in [
            "Land Moved",
            "Land Already",
            "Land MERGE_REQUIRED",
            "Land STALE_PARENT",
            "CreateBranch STALE_HEAD",
            "MoveBranch Moved",
            "MoveBranch FORBIDDEN",
            "DeleteBranch Moved",
            "DeleteBranch STALE_HEAD",
            "Tag ALREADY_EXISTS",
            "Revert Committed",
            "Revert CONFLICT",
            "MergeLand CONFLICT",
            "Rebase Rebased",
            "Rebase Already",
            "Rebase CONFLICT",
            "Probe Done",
            "Probe NOT_FOUND",
            "Probe FORBIDDEN",
            "SetVisibility Done",
            "SetVisibility FORBIDDEN",
            "Member Done",
            "Member NOT_FOUND",
        ] {
            assert!(tally.contains_key(label), "no {label} in {tally:?}");
        }
    }
}

#[test]
#[ignore = "larger run: cargo test -p yoneda-platform --lib differential -- --ignored"]
fn the_platform_matches_the_reference_model_at_length() {
    cases(100, 200);
}
