//! Path history from branches' first-parent chains answers exactly what walking first
//! parents answers: on main as it lands, on a working branch moved forward, rewound and
//! forced onto other work, for files, directories and paths under touched directories, now
//! and as of earlier versions.
use super::batches::open;
use super::*;
use crate::storage::SqlStore;

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
    let (h, root) = open();
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
            "SELECT version FROM repo_schema_migrations WHERE version>=38 ORDER BY version",
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
