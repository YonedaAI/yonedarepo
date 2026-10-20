//! Changeset landing (Scion model): path-disjoint landings append to the log without any
//! Git objects; an asynchronous, deterministic projector builds main's Git commits later.
use super::*;

const MERGER: &str = "platform:merge";
const PROJECTOR: &str = "platform:projection";

impl Harness {
    /// A tree from the object store as compute expects it (no cache-copy cross-check:
    /// projected trees were never returned by prepare).
    pub(super) fn raw_tree_json(&self, id: &str) -> Value {
        let (_, bytes) = &self.objects.borrow()[id];
        json!(decode_tree(bytes).unwrap().iter().map(|e| json!({"name": e.name, "id": e.id, "type": match e.mode {
            FileMode::Tree => "tree", FileMode::Executable => "exec", FileMode::Symlink => "symlink",
            FileMode::Gitlink => "gitlink", FileMode::Blob => "blob" }})).collect::<Vec<_>>())
    }
    /// One projector round as the adapter runs it: plan, compute (supplying trees), store
    /// the new objects, record. Returns what was recorded (None when nothing was pending).
    pub(super) fn project_once(&self) -> Option<Value> {
        let plan = self.ok(PROJECTOR, json!({"op":"repo_changeset_plan"}));
        if plan["items"].as_array().is_none_or(Vec::is_empty) {
            return None;
        }
        let built = self.project_compute(&plan);
        for object in built["projected"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|p| p["raw"].as_array().unwrap())
        {
            let data = STANDARD
                .decode(object["data_b64"].as_str().unwrap())
                .unwrap();
            let kind = match object["kind"].as_str().unwrap() {
                "commit" => ObjectKind::Commit,
                "tree" => ObjectKind::Tree,
                _ => ObjectKind::Blob,
            };
            self.objects
                .borrow_mut()
                .insert(object["id"].as_str().unwrap().into(), (kind, data));
        }
        for object in built["objects"].as_array().unwrap() {
            self.cached
                .borrow_mut()
                .insert(object["id"].as_str().unwrap().into(), object.clone());
        }
        Some(self.ok(
            PROJECTOR,
            json!({"op":"repo_changeset_record","ref":plan["ref"],"from":plan["head"]["id"],"items":built["projected"]}),
        ))
    }
    pub(super) fn project_compute(&self, plan: &Value) -> Value {
        let mut trees = serde_json::Map::new();
        loop {
            let step = crate::platform_compute(json!({"op":"project_changesets","head":plan["head"],"items":plan["items"],"trees":trees})).unwrap();
            let Some(need) = step["need_trees"].as_array() else {
                return step;
            };
            assert!(!need.is_empty());
            for id in need {
                let id = id.as_str().unwrap();
                trees.insert(id.into(), self.raw_tree_json(id));
            }
        }
    }
    pub(super) fn project_all(&self) {
        while self.project_once().is_some() {}
    }
    fn landable(&self, parent: &str, base: u64, changes: Value, read: Value) -> String {
        let id = self
            .commit(AGENT, Some(parent), base, changes, read)
            .unwrap();
        self.approve_and_check(&id);
        id
    }
    fn enqueue(&self, commit: &str) -> Value {
        self.ok(
            OWNER,
            json!({"op":"repo_land_enqueue","ref":"main","commit":commit}),
        )["ticket"]
            .clone()
    }
    fn status_of(&self, ticket: &Value) -> Value {
        self.ok(OWNER, json!({"op":"repo_land_status","ticket":ticket}))
    }
    pub(super) fn file_at(&self, commit: &str, path: &str) -> Option<String> {
        let objects = self.objects.borrow();
        let commit = Commit::decode(&objects[commit].1).unwrap();
        let mut tree = commit.tree().unwrap();
        let parts: Vec<&str> = path.split('/').collect();
        for (depth, part) in parts.iter().enumerate() {
            let entry = decode_tree(&objects[&tree.hex()].1)
                .unwrap()
                .into_iter()
                .find(|e| e.name == *part)?;
            if depth + 1 == parts.len() {
                return Some(String::from_utf8(objects[&entry.id.hex()].1.clone()).unwrap());
            }
            tree = entry.id;
        }
        None
    }
}

fn land_changesets(h: &Harness) -> Value {
    h.ok(MERGER, json!({"op":"repo_land_changesets","ref":"main"}))
}

#[test]
fn disjoint_landings_append_changesets_and_overlaps_fall_back_to_merges() {
    let (h, root) = seeded();
    let a = h.landable(&root, 1, json!([file("a.txt", "a\n")]), json!([]));
    let b = h.landable(&root, 1, json!([file("b.txt", "b\n")]), json!([]));
    let same_file = h.landable(&root, 1, json!([file("a.txt", "other\n")]), json!([]));
    let stale_read = h.landable(&root, 1, json!([file("e.txt", "e\n")]), json!(["a.txt"]));
    // Not a single commit on a main commit: its own touches are not its whole changeset.
    let chained = h.landable(&b, 1, json!([file("c.txt", "c\n")]), json!([]));
    let tickets: Vec<Value> = [&a, &b, &same_file, &stale_read, &chained]
        .iter()
        .map(|c| h.enqueue(c))
        .collect();
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_land_changesets","ref":"main"}))),
        "FORBIDDEN"
    );
    let landed = land_changesets(&h);
    // The first item sits on the head: an ordinary fast-forward; the second is disjoint
    // from it: a changeset. Items meeting the first's writes wait for the next batch (no
    // write skew within a batch); the chain waits for the merge path.
    assert_eq!(landed["landed"].as_array().unwrap().len(), 2, "{landed}");
    assert_eq!(landed["deferred"], json!([tickets[2], tickets[3]]));
    assert_eq!(landed["slow"], json!([tickets[4]]));
    assert_eq!(h.status_of(&tickets[0])["result"]["version"], 2);
    assert_eq!(h.status_of(&tickets[1])["status"], "landed");
    assert_eq!(h.status_of(&tickets[1])["result"]["version"], 3);
    assert_eq!(
        h.status_of(&tickets[1])["result"]["commit"],
        Value::Null,
        "not projected yet"
    );
    // Next batch, against a log holding `a`: the same file takes the merge path, the
    // stale read fails.
    let next = land_changesets(&h);
    assert_eq!(next["slow"], json!([tickets[2]]));
    for slow in [&tickets[2], &tickets[4]] {
        assert_eq!(h.status_of(slow)["status"], "pending");
    }
    let failed = h.status_of(&tickets[3]);
    assert_eq!(
        (failed["status"].as_str(), failed["result"]["code"].as_str()),
        (Some("failed"), Some("CONFLICT"))
    );
    let log = h.ok(OWNER, json!({"op":"repo_txlog","after":1}));
    let kinds: Vec<&str> = log["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["commit", "changeset"]);
    assert_eq!(
        log["entries"][1]["actor"], OWNER,
        "who queued it, not the merger"
    );
    assert_eq!(
        log["entries"][1]["projected"],
        json!({"commit": null, "at": null})
    );
    // Head reads fail closed until the projector catches up (the adapter projects and
    // retries); new work still begins, on the last projected head and its version.
    for read in [
        json!({"op":"repo_refs"}),
        json!({"op":"repo_snapshot","ref":"main"}),
        json!({"op":"repo_refs","at":3}),
    ] {
        assert_eq!(code(h.run(OWNER, read)), "PROJECTION_PENDING");
    }
    assert_eq!(
        code(h.run(MERGER, json!({"op":"repo_land_claim","ref":"main"}))),
        "PROJECTION_PENDING"
    );
    let begun = h.ok(
        AGENT,
        json!({"op":"repo_begin_commit","ref":"main","paths":["z.txt"]}),
    );
    assert_eq!(
        (begun["parent_id"].as_str(), begun["base_version"].as_u64()),
        (Some(a.as_str()), Some(2))
    );
    // A slow item is not retried by the next changeset batch.
    assert_eq!(land_changesets(&h)["landed"], json!([]));
    let fresh = h.landable(&root, 1, json!([file("f.txt", "f\n")]), json!([]));
    let fresh_ticket = h.enqueue(&fresh);

    h.project_all();
    let head = h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}));
    assert_eq!(head["version"], 3);
    assert_eq!(head["parents"], json!([a, b]));
    let head_id = head["commit"].as_str().unwrap();
    assert_eq!(h.file_at(head_id, "a.txt").as_deref(), Some("a\n"));
    assert_eq!(h.file_at(head_id, "b.txt").as_deref(), Some("b\n"));
    assert_eq!(h.file_at(head_id, "README.md").as_deref(), Some("# demo\n"));
    assert_eq!(h.status_of(&tickets[1])["result"]["commit"], head_id);
    let log = h.ok(OWNER, json!({"op":"repo_txlog","after":2}));
    assert_eq!(log["entries"][0]["projected"]["commit"], head_id);
    assert!(
        log["entries"][0]["projected"]["at"].as_i64().unwrap()
            > log["entries"][0]["committed_at_ms"].as_i64().unwrap()
    );
    // The merge path now takes the overlapping items against the projected head.
    let claim = h.ok(
        MERGER,
        json!({"op":"repo_land_claim","ref":"main","slow_only":true}),
    );
    assert_eq!(claim["head"], head_id);
    let claimed: Vec<&Value> = claim["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| &i["ticket"])
        .collect();
    assert_eq!(claimed, vec![&tickets[2], &tickets[4]]);
    assert_eq!(h.status_of(&fresh_ticket)["status"], "pending");
}

#[test]
fn projection_is_deterministic_idempotent_and_replays() {
    let run = || {
        let (h, root) = seeded();
        let ids: Vec<String> = ["a", "b", "c"]
            .iter()
            .map(|n| {
                h.landable(
                    &root,
                    1,
                    json!([file(&format!("dir/{n}.txt"), n)]),
                    json!([]),
                )
            })
            .collect();
        // A first landing moves main, so all three queued ones are changesets on it.
        let first = h.landable(&root, 1, json!([file("first.txt", "1\n")]), json!([]));
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
        for id in &ids {
            h.enqueue(id);
        }
        assert_eq!(land_changesets(&h)["landed"].as_array().unwrap().len(), 3);
        h
    };
    let (one, two) = (run(), run());
    let plan = one.ok(PROJECTOR, json!({"op":"repo_changeset_plan"}));
    assert_eq!(plan["items"].as_array().unwrap().len(), 3);
    // Same versions, same Git ids: computed twice here, and in an independent replica.
    let built = one.project_compute(&plan);
    assert_eq!(one.project_compute(&plan)["projected"], built["projected"]);
    let other = two.project_compute(&two.ok(PROJECTOR, json!({"op":"repo_changeset_plan"})));
    assert_eq!(other["projected"], built["projected"]);
    // A projector that crashed after computing (nothing recorded) is simply re-run.
    let recorded = one.project_once().unwrap();
    assert_eq!(recorded["version"], 5);
    // A duplicate record of the same projection is a no-op; a different one is refused.
    let again = json!({"op":"repo_changeset_record","ref":"refs/heads/main","from":plan["head"]["id"],"items":built["projected"]});
    assert_eq!(one.ok(PROJECTOR, again.clone())["already"], true);
    let mut forged = again.clone();
    forged["items"][1]["commit"] = json!("e".repeat(40));
    assert_eq!(code(one.run(PROJECTOR, forged)), "PROJECTION_MISMATCH");
    assert_eq!(
        code(one.run(AGENT, json!({"op":"repo_changeset_plan"}))),
        "FORBIDDEN"
    );
    // Time travel replays changeset entries through their projected commits.
    let projected: Vec<&Value> = built["projected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| &p["commit"])
        .collect();
    for (offset, commit) in projected.iter().enumerate() {
        let at = 3 + offset as u64;
        assert_eq!(
            one.ok(OWNER, json!({"op":"repo_refs","at":at}))["refs"]["refs/heads/main"],
            **commit
        );
    }
    assert_eq!(
        one.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}))["commit"],
        *projected[2]
    );
    assert_eq!(one.project_once(), None);
}

#[test]
fn a_plan_never_holds_more_steps_than_a_record_takes() {
    let (h, root) = seeded();
    let first = h.landable(&root, 1, json!([file("first.txt", "1\n")]), json!([]));
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    for i in 0..70 {
        let id = h.landable(
            &root,
            1,
            json!([file(&format!("many/{i}.txt"), "x\n")]),
            json!([]),
        );
        h.enqueue(&id);
    }
    land_changesets(&h);
    let plan = h.ok(PROJECTOR, json!({"op":"repo_changeset_plan"}));
    assert_eq!(plan["items"].as_array().unwrap().len(), 64);
    h.project_all();
    assert_eq!(h.project_once(), None, "all 70 projected over two records");
}

#[test]
fn vacuum_never_releases_unprojected_changesets() {
    let (h, root) = seeded();
    let first = h.landable(&root, 1, json!([file("first.txt", "1\n")]), json!([]));
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    let b = h.landable(&root, 1, json!([file("b.txt", "b\n")]), json!([]));
    h.enqueue(&b);
    land_changesets(&h);
    // Long after retention, with main's earlier projection in sync.
    *h.now.borrow_mut() += 30 * 24 * 60 * 60 * 1000;
    h.ok(PROJECTOR, json!({"op":"repo_projection_result","refname":"refs/heads/main","version":2,"outcome":"ok","commit":first}));
    let held = |h: &Harness| {
        let plan = h.ok(OWNER, json!({"op":"repo_vacuum_plan"}));
        let all: Vec<Value> = ["covered", "expired"]
            .iter()
            .flat_map(|k| plan[k].as_array().unwrap().clone())
            .collect();
        !all.contains(&json!(b))
    };
    assert!(held(&h), "the landed changeset's commit is still needed");
    h.project_all();
    assert!(
        held(&h),
        "projected, but not yet in the object store's main"
    );
    let head = h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}))["commit"].clone();
    h.ok(PROJECTOR, json!({"op":"repo_projection_result","refname":"refs/heads/main","version":3,"outcome":"ok","commit":head}));
    assert!(!held(&h), "reachable from projected main: released");
}

#[test]
fn grants_bound_changesets_and_owner_fast_forward_waits_for_projection() {
    let (h, root) = seeded();
    const DOCS: &str = "token:docs";
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write","land"],
        "paths":["docs/"],"_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    let first = h.landable(&root, 1, json!([file("first.txt", "1\n")]), json!([]));
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    let inside = h.landable(&root, 1, json!([file("docs/a.md", "a\n")]), json!([]));
    let outside = h.landable(&root, 1, json!([file("src/lib.rs", "x\n")]), json!([]));
    // A scoped lander cannot queue work touching paths outside its grant.
    assert_eq!(
        code(h.run(
            DOCS,
            json!({"op":"repo_land","ref":"main","commit":outside,"enqueue":true})
        )),
        "FORBIDDEN"
    );
    let queued = h.ok(
        DOCS,
        json!({"op":"repo_land","ref":"main","commit":inside,"enqueue":true}),
    );
    assert_eq!(queued["queued"], true);
    land_changesets(&h);
    let entry = h.ok(OWNER, json!({"op":"repo_txlog","after":2}))["entries"][0].clone();
    assert_eq!(
        (entry["kind"].as_str(), entry["paths"][0]["path"].as_str()),
        (Some("changeset"), Some("docs/a.md"))
    );
    // The owner's fast-forward-only landing compares against the latest version: it waits
    // for the projection, then lands on the projected head and reads back as itself.
    let owner = h.landable(&first, 2, json!([file("owner.txt", "o\n")]), json!([]));
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":owner,"fast_forward_only":true})
        )),
        "PROJECTION_PENDING"
    );
    h.project_all();
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":owner,"fast_forward_only":true})
        )),
        "STALE_HEAD",
        "it was built on a head older than the latest version"
    );
    let head = h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}));
    let fresh = h.landable(
        head["commit"].as_str().unwrap(),
        head["version"].as_u64().unwrap(),
        json!([file("owner.txt", "o\n")]),
        json!([]),
    );
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":fresh,"fast_forward_only":true}),
    );
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_refs"}))["refs"]["refs/heads/main"],
        fresh
    );
}

#[test]
fn the_path_index_migration_backfills_existing_log_entries() {
    use crate::storage::SqlStore;
    let (h, root) = seeded();
    let moved = h.landable(&root, 1, json!([file("a/b.txt", "b\n")]), json!([]));
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":moved}));
    h.ok(
        OWNER,
        json!({"op":"repo_branch_set","ref":"side","commit":root}),
    );
    let index = |h: &Harness| {
        h.db.query(
            "SELECT refname,path,version FROM txlog_paths ORDER BY version,path",
            &[],
        )
        .unwrap()
    };
    let written = index(&h);
    assert_eq!(
        written
            .iter()
            .map(|r| r["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["README.md", "src/lib.rs", "a/b.txt", ""],
        "a branch move without paths is filed under the empty path"
    );
    h.db.query("DELETE FROM txlog_paths", &[]).unwrap();
    let sql = include_str!("../../migrations/repo_store/0018_changesets.sql");
    for statement in sql
        .split(';')
        .filter(|s| s.contains("INSERT OR IGNORE INTO txlog_paths"))
    {
        h.db.query(statement, &[]).unwrap();
    }
    assert_eq!(index(&h), written);
}

/// Write skew (Adya G2-item): `a` reads x and writes y, `b` reads y and writes x. Each is
/// independent of the log since its base, but no serial order explains both landing.
fn skewed(h: &Harness, root: &str) -> (String, String) {
    let first = h.landable(root, 1, json!([file("first.txt", "1\n")]), json!([]));
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    (
        h.landable(root, 1, json!([file("y.txt", "y\n")]), json!(["x.txt"])),
        h.landable(root, 1, json!([file("x.txt", "x\n")]), json!(["y.txt"])),
    )
}

#[test]
fn a_changeset_batch_never_lands_write_skew() {
    let (h, root) = seeded();
    let (a, b) = skewed(&h, &root);
    let tickets = [h.enqueue(&a), h.enqueue(&b)];
    let landed = land_changesets(&h);
    assert_eq!(landed["landed"].as_array().unwrap().len(), 1, "{landed}");
    assert_eq!(landed["deferred"], json!([tickets[1]]));
    assert_eq!(landed["more"], true);
    assert_eq!(h.status_of(&tickets[0])["status"], "landed");
    assert_eq!(h.status_of(&tickets[1])["status"], "pending");
    // The next batch validates it against a log that holds `a`: its read of y is stale.
    land_changesets(&h);
    let other = h.status_of(&tickets[1]);
    assert_eq!(
        (other["status"].as_str(), other["result"]["code"].as_str()),
        (Some("failed"), Some("CONFLICT"))
    );
}

#[test]
fn a_batch_merge_never_lands_write_skew() {
    let (h, root) = seeded();
    let (a, b) = skewed(&h, &root);
    let tickets = [h.enqueue(&a), h.enqueue(&b)];
    let claim = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    assert_eq!(claim["items"].as_array().unwrap().len(), 2);
    let blob = |t: &str| yoneda_core::git_object::hash_object(ObjectKind::Blob, t.as_bytes());
    let merge = h
        .commit_with(MERGER, claim["head"].as_str(), 2,
            json!([{"path":"x.txt","blob":blob("x\n"),"type":"blob"},{"path":"y.txt","blob":blob("y\n"),"type":"blob"}]),
            json!([]), json!({"merge_parents": [a, b]}))
        .unwrap();
    let batch = h.run(
        MERGER,
        json!({"op":"repo_land_batch","ref":"main","epoch":claim["epoch"],
        "head":claim["head"],"merge":merge,"landed":[tickets[0], tickets[1]]}),
    );
    assert_eq!(code(batch), "WRITE_SKEW");
    assert_eq!(h.status_of(&tickets[0])["status"], "pending");
}
