//! Path history from branches' first-parent chains answers exactly what walking first
//! parents answers: on main as it lands, on a working branch moved forward, rewound and
//! forced onto other work, for files, directories and paths under touched directories, now
//! and as of earlier versions.
use super::batches::open;
use super::*;
use crate::storage::SqlStore;
use yoneda_core::git_object::ObjectId;

fn shared() -> Value {
    json!({"_ref_chain":"shared"})
}

/// Rows `refname`'s own chain stores.
fn stored(h: &Harness, refname: &str) -> u64 {
    h.db.query(
        "SELECT COUNT(*) AS n FROM ref_chain WHERE ref=?",
        &[json!(refname)],
    )
    .unwrap()[0]["n"]
        .as_u64()
        .unwrap()
}

/// Main with `n` commits landed on `root`, one file each: `[root, first, ..]`.
fn landed(h: &Harness, root: String, n: u64) -> Vec<String> {
    let paths = ["src/a.rs", "docs/x.md", "n.txt"];
    let mut main = vec![root];
    for i in 0..n {
        let path = paths[i as usize % paths.len()];
        let id = h
            .commit(
                AGENT,
                main.last().map(String::as_str),
                i + 1,
                json!([file(path, &format!("{i}\n"))]),
                json!([]),
            )
            .unwrap();
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
        main.push(id);
    }
    main
}

/// `n` commits on top of `parent`, each changing `src/a.rs`, oldest first.
fn work(h: &Harness, parent: &str, n: u64) -> Vec<String> {
    let mut made = vec![parent.to_owned()];
    for i in 0..n {
        let id = h
            .commit(
                AGENT,
                made.last().map(String::as_str),
                i + 1,
                json!([file("src/a.rs", &format!("work {i}\n"))]),
                json!([]),
            )
            .unwrap();
        made.push(id);
    }
    made.remove(0);
    made
}

fn set(h: &Harness, refname: &str, commit: &str, expected: Value) {
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":refname,"commit":commit,"expected":expected}),
    );
}

fn depth_on(h: &Harness, refname: &str, id: &str) -> Option<i64> {
    let id = ObjectId::parse(id).unwrap();
    super::super::ref_chain::depth(&h.db, refname, &id).unwrap()
}

fn history(h: &Harness, refname: &str, path: &str, at: Option<u64>) -> Value {
    let mut c = json!({"op":"repo_path_history","ref":refname,"path":path,"limit":50});
    if let Some(at) = at {
        c["at"] = json!(at);
    }
    h.ok(CI, c)
}

/// Each query answered from the chains, then again with the chains dropped (the walk).
fn same_as_the_walk(h: &Harness, queries: &[(&str, &str, Option<u64>)]) {
    let chained: Vec<Value> = queries
        .iter()
        .map(|(r, p, at)| history(h, r, p, *at))
        .collect();
    let saved =
        h.db.query("SELECT ref,depth,commit_id FROM ref_chain", &[])
            .unwrap();
    assert!(!saved.is_empty(), "chains are kept as refs move");
    h.db.query("DELETE FROM ref_chain", &[]).unwrap();
    for ((r, p, at), chained) in queries.iter().zip(chained) {
        assert_eq!(history(h, r, p, *at), chained, "{r} {p} at {at:?}");
    }
    for row in saved {
        h.db.query(
            "INSERT INTO ref_chain(ref,depth,commit_id) VALUES(?,?,?)",
            &[
                row["ref"].clone(),
                row["depth"].clone(),
                row["commit_id"].clone(),
            ],
        )
        .unwrap();
    }
}

#[test]
fn chains_answer_path_history_as_the_walk_does() {
    chains_answer_as_the_walk(json!({}));
}

#[test]
fn chains_sharing_main_answer_path_history_as_the_walk_does() {
    chains_answer_as_the_walk(shared());
}

fn chains_answer_as_the_walk(switches: Value) {
    let (h, root) = open();
    *h.switches.borrow_mut() = switches;
    let paths = [
        "src/a.rs",
        "src/b.rs",
        "docs/x.md",
        "n.txt",
        "src/deep/c.rs",
    ];
    let mut main = vec![root.clone()];
    for i in 0..12u64 {
        let path = paths[i as usize % paths.len()];
        let id = h
            .commit(
                AGENT,
                main.last().map(String::as_str),
                i + 1,
                json!([file(path, &format!("{i}\n"))]),
                json!([]),
            )
            .unwrap();
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
        main.push(id);
    }
    let version = |id: &str| {
        h.ok(CI, json!({"op":"repo_commit","commit":id}))["landings"][0]["version"]
            .as_u64()
            .unwrap()
    };
    // A working branch: forward from main's fourth commit, rewound, then forced onto
    // other work (commits main never had).
    let set = |commit: &str, expected: Value| {
        h.ok(AGENT, json!({"op":"repo_branch_set","ref":"refs/heads/w","commit":commit,"expected":expected}));
    };
    set(&main[4], Value::Null);
    set(&main[9], json!(main[4]));
    set(&main[2], json!(main[9]));
    let mut side = main[2].clone();
    for i in 0..3u64 {
        side = h
            .commit(
                AGENT,
                Some(&side),
                i + 1,
                json!([file("src/a.rs", &format!("side {i}\n"))]),
                json!([]),
            )
            .unwrap();
    }
    set(&side, json!(main[2]));
    let mut queries = Vec::new();
    for path in [
        "src",
        "src/",
        "src/a.rs",
        "src/deep",
        "n.txt",
        "docs/x.md/inner",
        "missing",
    ] {
        queries.push(("main", path, None));
        queries.push(("refs/heads/w", path, None));
        queries.push(("main", path, Some(version(&main[6]))));
    }
    same_as_the_walk(&h, &queries);
    assert_eq!(
        history(&h, "refs/heads/w", "src/a.rs", None)["commits"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
}

#[test]
fn upgrading_from_0038_answers_from_the_walk_then_from_the_chain_after_a_move() {
    let (h, root) = open();
    let paths = ["src/a.rs", "docs/x.md", "n.txt"];
    let mut main = vec![root];
    for i in 0..9u64 {
        let id = h
            .commit(
                AGENT,
                main.last().map(String::as_str),
                i + 1,
                json!([file(paths[i as usize % 3], &format!("{i}\n"))]),
                json!([]),
            )
            .unwrap();
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
        main.push(id);
    }
    let version = |id: &str| {
        h.ok(CI, json!({"op":"repo_commit","commit":id}))["landings"][0]["version"]
            .as_u64()
            .unwrap()
    };
    let past = version(&main[5]);
    let queries = [("src", None), ("n.txt", None), ("src/a.rs", Some(past))];
    // What the walk answers, before the chain existed.
    h.db.query("DELETE FROM ref_chain", &[]).unwrap();
    let walked: Vec<Value> = queries
        .iter()
        .map(|(p, at)| history(&h, "main", p, *at))
        .collect();
    // The store as 0038 (and 0040, applied first on deployed repositories) left it.
    h.db.query("DROP TABLE ref_chain", &[]).unwrap();
    h.db.query("DELETE FROM repo_schema_migrations WHERE version=39", &[])
        .unwrap();
    super::super::migrate_repo_store(&h.db).unwrap();
    let applied: Vec<i64> =
        h.db.query(
            "SELECT version FROM repo_schema_migrations WHERE version BETWEEN 38 AND 40 ORDER BY version",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r["version"].as_i64().unwrap())
        .collect();
    assert_eq!(applied, [38, 39, 40]);
    // Upgraded: no chain yet, so the walk answers, the same.
    for ((p, at), walked) in queries.iter().zip(&walked) {
        assert_eq!(
            &history(&h, "main", p, *at),
            walked,
            "{p} after the upgrade"
        );
    }
    // One move builds main's chain; the same questions are answered from it.
    let next = h
        .commit(
            AGENT,
            main.last().map(String::as_str),
            10,
            json!([file("other.txt", "x\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":next}));
    let chain =
        h.db.query(
            "SELECT COUNT(*) AS n FROM ref_chain WHERE ref='refs/heads/main'",
            &[],
        )
        .unwrap()[0]["n"]
            .as_u64()
            .unwrap();
    assert_eq!(chain, main.len() as u64 + 1);
    for ((p, at), walked) in queries.iter().zip(&walked) {
        assert_eq!(&history(&h, "main", p, *at), walked, "{p} from the chain");
    }
}

#[test]
fn a_branch_stores_only_what_main_does_not_hold() {
    let (h, root) = open();
    *h.switches.borrow_mut() = shared();
    let main = landed(&h, root, 12);
    assert_eq!(stored(&h, "refs/heads/main"), 13);
    // A branch at main's head holds a single row, however long main is.
    set(&h, "refs/heads/at-head", &main[12], Value::Null);
    assert_eq!(stored(&h, "refs/heads/at-head"), 1);
    // Three commits off an older commit of main hold three rows.
    let side = work(&h, &main[5], 3);
    set(&h, "refs/heads/side", &side[2], Value::Null);
    assert_eq!(stored(&h, "refs/heads/side"), 3);
    // Through a batch too, which sends each move as a command of its own.
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"batched","commit":side[2],"expected":null}]}),
    );
    assert_eq!(stored(&h, "refs/heads/batched"), 3);
    // Off, a new branch copies its whole history, as ever.
    *h.switches.borrow_mut() = json!({});
    set(&h, "refs/heads/full", &side[2], Value::Null);
    assert_eq!(stored(&h, "refs/heads/full"), 9);
}

#[test]
fn a_chain_on_main_holds_main_below_where_it_left_and_nothing_above() {
    let (h, root) = open();
    *h.switches.borrow_mut() = shared();
    let main = landed(&h, root, 12);
    let side = work(&h, &main[5], 3);
    set(&h, "refs/heads/side", &side[2], Value::Null);
    let w = "refs/heads/side";
    assert_eq!(depth_on(&h, w, &main[0]), Some(1));
    assert_eq!(depth_on(&h, w, &main[5]), Some(6));
    assert_eq!(depth_on(&h, w, &side[0]), Some(7));
    assert_eq!(depth_on(&h, w, &side[2]), Some(9));
    // Main moved on past where the branch left: that work is not the branch's.
    assert_eq!(depth_on(&h, w, &main[6]), None);
    assert_eq!(depth_on(&h, w, &main[12]), None);
    // Main itself and a branch with no chain answer as they did.
    assert_eq!(depth_on(&h, "refs/heads/main", &side[0]), None);
    assert_eq!(depth_on(&h, "refs/heads/none", &main[1]), None);
}

#[test]
fn a_chain_on_main_moves_like_any_chain() {
    let (h, root) = open();
    *h.switches.borrow_mut() = shared();
    let main = landed(&h, root, 12);
    let side = work(&h, &main[5], 3);
    let w = "refs/heads/w";
    let same = |h: &Harness| {
        let queries: Vec<(&str, &str, Option<u64>)> = ["src", "src/a.rs", "n.txt", "docs/x.md"]
            .iter()
            .map(|p| (w, *p, None))
            .collect();
        same_as_the_walk(h, &queries);
    };
    set(&h, w, &side[2], Value::Null);
    same(&h);
    // Forward by one: the chain grows by one.
    let next = work(&h, &side[2], 1);
    set(&h, w, &next[0], json!(side[2]));
    assert_eq!(stored(&h, w), 4);
    same(&h);
    // Rewound inside its own rows.
    set(&h, w, &side[0], json!(next[0]));
    assert_eq!(stored(&h, w), 1);
    same(&h);
    // Rewound below where it left main: only that commit is stored.
    set(&h, w, &main[3], json!(side[0]));
    assert_eq!(stored(&h, w), 1);
    assert_eq!(depth_on(&h, w, &main[3]), Some(4));
    assert_eq!(depth_on(&h, w, &main[4]), None);
    same(&h);
    // Forced onto work that left main higher up than the rows it holds.
    let later = work(&h, &main[9], 2);
    set(&h, w, &later[1], json!(main[3]));
    assert_eq!(stored(&h, w), 2);
    assert_eq!(depth_on(&h, w, &main[9]), Some(10));
    same(&h);
    // Fast-forwarded onto main's head.
    set(&h, w, &main[12], json!(later[1]));
    assert_eq!(stored(&h, w), 1);
    same(&h);
    // Deleted, it holds nothing and main keeps all of its own.
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":w,"commit":null,"expected":main[12]}]}),
    );
    assert_eq!(stored(&h, w), 0);
    assert_eq!(stored(&h, "refs/heads/main"), 13);
}

#[test]
fn the_switch_can_go_back_off_and_a_chain_kept_whole_stays_whole() {
    let (h, root) = open();
    let main = landed(&h, root, 12);
    let w = "refs/heads/w";
    let queries = [(w, "src", None), (w, "n.txt", None)];
    // Built off, then moved on: it keeps its rows and grows from them.
    let side = work(&h, &main[5], 2);
    set(&h, w, &side[0], Value::Null);
    assert_eq!(stored(&h, w), 7);
    *h.switches.borrow_mut() = shared();
    set(&h, w, &side[1], json!(side[0]));
    assert_eq!(stored(&h, w), 8);
    same_as_the_walk(&h, &queries);
    // Built on, then moved with the switch off: still answered, forward and rewound.
    set(&h, w, &main[12], json!(side[1]));
    assert_eq!(stored(&h, w), 1);
    *h.switches.borrow_mut() = json!({});
    same_as_the_walk(&h, &queries);
    let next = work(&h, &main[12], 1);
    set(&h, w, &next[0], json!(main[12]));
    assert_eq!(stored(&h, w), 2);
    same_as_the_walk(&h, &queries);
    set(&h, w, &main[2], json!(next[0]));
    assert_eq!(stored(&h, w), 3);
    same_as_the_walk(&h, &queries);
}

#[test]
fn a_chain_main_no_longer_continues_is_walked() {
    let (h, root) = open();
    *h.switches.borrow_mut() = shared();
    let main = landed(&h, root, 12);
    let side = work(&h, &main[5], 3);
    let w = "refs/heads/w";
    set(&h, w, &side[2], Value::Null);
    let answered = history(&h, w, "n.txt", None);
    assert!(!answered["commits"].as_array().unwrap().is_empty());
    // Main never rewinds, but the proof is read each time rather than assumed.
    h.db.query(
        "UPDATE ref_chain SET commit_id=? WHERE ref='refs/heads/main' AND depth=6",
        &[json!(main[11])],
    )
    .unwrap();
    assert_eq!(history(&h, w, "n.txt", None), answered);
    // Below its own rows the branch now proves nothing, so gates refuse rather than assume.
    assert_eq!(depth_on(&h, w, &main[3]), None);
}

#[test]
fn a_landing_on_a_chain_sharing_main_meets_it_below_where_it_left() {
    // `older_commits_pass` walks down to the ref: an old commit of main is on the branch.
    let (h, root) = open();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write","land"],
        "paths":["docs/"],"_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    *h.switches.borrow_mut() = shared();
    let main = landed(&h, root, 12);
    let side = work(&h, &main[5], 1);
    set(&h, "refs/heads/w", &side[0], Value::Null);
    let docs = h
        .commit(
            "token:docs",
            Some(&main[2]),
            1,
            json!([file("docs/new.md", "x\n")]),
            json!([]),
        )
        .unwrap();
    assert_ne!(
        code(h.run(
            "token:docs",
            json!({"op":"repo_land","ref":"w","commit":docs})
        )),
        "FORBIDDEN"
    );
}
