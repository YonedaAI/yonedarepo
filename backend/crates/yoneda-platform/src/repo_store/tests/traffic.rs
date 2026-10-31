//! Traffic warnings: a session starting or reading a file hears which open Landings are changing
//! it, same symbol first, then same file, then a Landing that read it. The reads are bounded by
//! the Landings asked about, not by the repository's history, and a warning never shows what a
//! grant or quarantine keeps from the caller.
use super::*;
use crate::repo_store::traffic::{self, Ask};
use std::collections::BTreeSet;

/// Open policy: a branch off `parent` with commits writing `paths`, reading `reads`.
fn branch(h: &Harness, name: &str, parent: &str, paths: &[&str], reads: Value) -> String {
    let changes: Vec<Value> = paths.iter().map(|p| file(p, name)).collect();
    let id = h
        .commit(AGENT, Some(parent), 1, json!(changes), reads)
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":name,"commit":id,"expected":null}),
    );
    id
}

fn landing(h: &Harness, name: &str) -> i64 {
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":name,"title":format!("Work on {name}")}),
    )["number"]
        .as_i64()
        .unwrap()
}

fn symbols(h: &Harness, commit: &str, path: &str, names: Value) {
    h.ok(
        "platform:derive",
        json!({"op":"repo_record_symbols","commit":commit,"touches":[{"path":path,"symbols":names}]}),
    );
}

fn relevant(h: &Harness, ask: Value) -> Value {
    let mut c = ask;
    c["op"] = json!("repo_context_relevant");
    h.ok(AGENT, c)["traffic"].clone()
}

/// `(landing, overlap, path)` of each warning, in order.
fn seen(traffic: &Value) -> Vec<(i64, String, String)> {
    traffic["warnings"]
        .as_array()
        .unwrap_or_else(|| panic!("no warnings in {traffic}"))
        .iter()
        .map(|w| {
            (
                w["landing"].as_i64().unwrap(),
                w["overlap"].as_str().unwrap().to_owned(),
                w["path"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn warned(landing: i64, overlap: &str, path: &str) -> (i64, String, String) {
    (landing, overlap.to_owned(), path.to_owned())
}

#[test]
fn a_session_hears_which_landing_is_changing_its_file() {
    let (h, root) = seeded();
    branch(&h, "fix", &root, &["src/net.rs"], json!([]));
    let number = landing(&h, "fix");
    let read = relevant(
        &h,
        json!({"paths":["src/net.rs"],"types":["memory","contract"]}),
    );
    assert_eq!(seen(&read), [warned(number, "file", "src/net.rs")]);
    let warning = &read["warnings"][0];
    assert_eq!(warning["title"], "Work on fix");
    assert_eq!(warning["branch"], "fix");
    assert_eq!(warning["author"], AGENT);
    // At a session's start too, and nothing on a file no Landing touches.
    let start = h.ok(
        AGENT,
        json!({"op":"repo_agent_context","paths":["src/net.rs"]}),
    );
    assert_eq!(
        seen(&start["traffic"]),
        [warned(number, "file", "src/net.rs")]
    );
    let named = h.ok(
        AGENT,
        json!({"op":"repo_agent_context","symbols":["src/net.rs#retry"]}),
    );
    assert_eq!(
        seen(&named["traffic"]),
        [warned(number, "file", "src/net.rs")]
    );
    assert!(seen(&relevant(&h, json!({"paths":["README.md"]}))).is_empty());
    // A directory asked for covers the files under it.
    let dir = relevant(&h, json!({"paths":["src/"]}));
    assert_eq!(seen(&dir), [warned(number, "file", "src/net.rs")]);
}

#[test]
fn the_same_symbol_leads_then_the_same_file_then_a_landing_that_read_it() {
    let (h, root) = seeded();
    branch(&h, "reads", &root, &["docs/a.md"], json!(["src/lib.rs"]));
    let first = landing(&h, "reads");
    let file_only = branch(&h, "file", &root, &["src/lib.rs"], json!([]));
    let second = landing(&h, "file");
    symbols(&h, &file_only, "src/lib.rs", json!(["other"]));
    let same = branch(&h, "same", &root, &["src/lib.rs"], json!([]));
    let third = landing(&h, "same");
    symbols(&h, &same, "src/lib.rs", json!(["Policy::backoff"]));
    let ranked = relevant(
        &h,
        json!({"paths":["src/lib.rs"],"symbols":["src/lib.rs#Policy"]}),
    );
    assert_eq!(
        seen(&ranked),
        [
            warned(third, "symbol", "src/lib.rs"),
            warned(second, "file", "src/lib.rs"),
            warned(first, "read", "src/lib.rs"),
        ]
    );
    assert_eq!(ranked["warnings"][0]["symbols"], json!(["Policy::backoff"]));
    // Asked for a file alone, a Landing's symbols still say what it is changing there.
    let plain = relevant(&h, json!({"paths":["src/lib.rs"]}));
    assert_eq!(plain["warnings"][0]["overlap"], "file");
    assert_eq!(plain["warnings"][0]["symbols"], json!(["Policy::backoff"]));
}

#[test]
fn a_read_of_a_directory_or_symbol_meets_the_file_under_it() {
    let (h, root) = seeded();
    branch(&h, "dir", &root, &["docs/a.md"], json!(["src/"]));
    let dir = landing(&h, "dir");
    branch(&h, "sym", &root, &["docs/b.md"], json!(["src/lib.rs#a"]));
    let sym = landing(&h, "sym");
    let read = relevant(&h, json!({"paths":["src/lib.rs"]}));
    assert_eq!(
        seen(&read),
        [
            warned(sym, "read", "src/lib.rs"),
            warned(dir, "read", "src/")
        ]
    );
}

#[test]
fn a_session_is_not_warned_about_its_own_branch() {
    let (h, root) = seeded();
    branch(&h, "mine", &root, &["src/net.rs"], json!([]));
    let mine = landing(&h, "mine");
    assert_eq!(
        seen(&relevant(&h, json!({"paths":["src/net.rs"]}))),
        [warned(mine, "file", "src/net.rs")]
    );
    let own = relevant(&h, json!({"paths":["src/net.rs"],"branch":"mine"}));
    assert!(seen(&own).is_empty(), "{own}");
}

#[test]
fn a_session_on_a_branch_is_warned_about_what_the_branch_changed() {
    let (h, root) = seeded();
    let mine = branch(&h, "mine", &root, &["src/net.rs"], json!([]));
    symbols(&h, &mine, "src/net.rs", json!(["retry"]));
    let theirs = branch(&h, "theirs", &root, &["src/net.rs"], json!([]));
    symbols(&h, &theirs, "src/net.rs", json!(["retry", "other"]));
    let number = landing(&h, "theirs");
    // The clone names nothing: the branch's pushed work is what it is changing.
    let start = h.ok(AGENT, json!({"op":"repo_agent_context","branch":"mine"}));
    assert_eq!(
        seen(&start["traffic"]),
        [warned(number, "symbol", "src/net.rs")]
    );
    assert_eq!(start["traffic"]["warnings"][0]["symbols"], json!(["retry"]));
    // Reading a file, the branch's symbols rank it, and only that file is warned about.
    let read = relevant(&h, json!({"paths":["src/net.rs"],"branch":"mine"}));
    assert_eq!(seen(&read), [warned(number, "symbol", "src/net.rs")]);
    assert!(
        seen(&relevant(
            &h,
            json!({"paths":["README.md"],"branch":"mine"})
        ))
        .is_empty()
    );
}

#[test]
fn only_what_a_landing_adds_counts_every_commit_of_it() {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}}),
    );
    // main moves on, and a Landing branches from there with two commits.
    let on_main = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("old.rs", "x")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":on_main}),
    );
    let lower = h
        .commit(
            AGENT,
            Some(&on_main),
            2,
            json!([file("lower.rs", "x")]),
            json!([]),
        )
        .unwrap();
    let upper = h
        .commit(
            AGENT,
            Some(&lower),
            2,
            json!([file("upper.rs", "x")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"two","commit":upper,"expected":null}),
    );
    let number = landing(&h, "two");
    let read = relevant(&h, json!({"paths":["old.rs","lower.rs","upper.rs"]}));
    assert_eq!(
        seen(&read),
        [
            warned(number, "file", "lower.rs"),
            warned(number, "file", "upper.rs")
        ]
    );
}

#[test]
fn a_closed_or_landed_landing_is_no_traffic() {
    let (h, root) = seeded();
    branch(&h, "fix", &root, &["src/net.rs"], json!([]));
    let number = landing(&h, "fix");
    h.ok(AGENT, json!({"op":"repo_change_close","number":number}));
    assert!(seen(&relevant(&h, json!({"paths":["src/net.rs"]}))).is_empty());
}

#[test]
fn warnings_are_bounded_per_landing_and_counted() {
    let (h, root) = seeded();
    let paths: Vec<String> = (0..12).map(|n| format!("src/f{n:02}.rs")).collect();
    let names: Vec<&str> = paths.iter().map(String::as_str).collect();
    branch(&h, "big", &root, &names, json!([]));
    landing(&h, "big");
    branch(&h, "small", &root, &["src/f00.rs"], json!([]));
    landing(&h, "small");
    let read = relevant(&h, json!({"paths": names}));
    let shown = seen(&read);
    assert_eq!(shown.len(), 4, "{read}");
    assert_eq!(shown.iter().filter(|w| w.0 == 1).count(), 3);
    assert_eq!(read["more"], 9);
}

#[test]
fn delivered_warnings_are_not_repeated_to_the_session() {
    let (h, root) = seeded();
    branch(&h, "fix", &root, &["src/a.rs", "src/b.rs"], json!([]));
    let number = landing(&h, "fix");
    let ask = json!({"paths":["src/a.rs","src/b.rs"],"session_id":"s1"});
    assert_eq!(seen(&relevant(&h, ask.clone())).len(), 2);
    h.ok(
        AGENT,
        json!({"op":"repo_context_deliver","session_id":"s1","trigger":"read","subject":"src/a.rs",
               "items":[{"type":"traffic","id":number,"path":"src/a.rs"}],"bytes":90}),
    );
    assert_eq!(
        seen(&relevant(&h, ask)),
        [warned(number, "file", "src/b.rs")]
    );
    // A session's list says what it was told.
    let listed = h.ok(
        AGENT,
        json!({"op":"repo_context_deliveries","session_id":"s1"}),
    );
    assert_eq!(
        listed["deliveries"][0]["items"][0]["label"],
        format!("Landing #{number}: src/a.rs")
    );
    let bad = json!({"op":"repo_context_deliver","session_id":"s1","trigger":"start",
                     "items":[{"type":"traffic","id":number}],"bytes":1});
    assert_eq!(h.run(AGENT, bad).unwrap_err().code, "INVALID_INPUT");
}

#[test]
fn a_quarantined_blob_is_no_traffic() {
    let (h, root) = seeded();
    let id = branch(&h, "fix", &root, &["src/net.rs"], json!([]));
    landing(&h, "fix");
    symbols(&h, &id, "src/net.rs", json!(["secret_name"]));
    branch(&h, "other", &root, &["src/net.rs"], json!([]));
    let other = landing(&h, "other");
    assert_eq!(
        seen(&relevant(&h, json!({"paths":["src/net.rs"]}))).len(),
        2
    );
    // `branch` writes its own name, so this withholds the file `fix` wrote.
    let blob = hash_object(ObjectKind::Blob, b"fix").hex();
    h.ok(
        OWNER,
        json!({"op":"repo_quarantine","target":{"kind":"blob","id":blob},"path":"src/net.rs",
               "reason":"leaked"}),
    );
    let read = relevant(&h, json!({"paths":["src/net.rs"]}));
    assert_eq!(seen(&read), [warned(other, "file", "src/net.rs")]);
    assert!(!read.to_string().contains("secret_name"), "{read}");
}

#[test]
fn a_token_never_sees_a_path_outside_its_grant() {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write"],"paths":["docs/"],
               "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    branch(&h, "fix", &root, &["docs/a.md", "src/net.rs"], json!([]));
    let number = landing(&h, "fix");
    // Both reads describe the whole repository, so such a token gets neither.
    for op in [
        json!({"op":"repo_agent_context","paths":["src/net.rs"]}),
        json!({"op":"repo_context_relevant","paths":["src/net.rs"]}),
    ] {
        assert_eq!(h.run("token:docs", op).unwrap_err().code, "FORBIDDEN");
    }
    // And the read itself keeps to the caller's grant, whoever calls it.
    let ask = Ask {
        files: BTreeSet::from(["docs/a.md".to_owned(), "src/net.rs".to_owned()]),
        ..Ask::default()
    };
    let grant = Some(vec!["docs/".to_owned()]);
    let read = traffic::warnings(&h.db, &ask, &grant, &BTreeSet::new()).unwrap();
    assert_eq!(seen(&read), [warned(number, "file", "docs/a.md")]);
}

#[test]
fn a_warning_costs_the_same_however_long_the_history_or_many_the_landings() {
    fn cost(h: &Harness) -> yoneda_store::counted::SqlCounts {
        let before = h.db.counts();
        relevant(h, json!({"paths":["src/hot.rs"],"types":["memory"]}));
        h.db.counts() - before
    }
    // Nothing open: one more statement than the ranking alone.
    let (quiet, _) = seeded();
    let none = cost(&quiet);

    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}}),
    );
    // A long main: every commit of it touches the file asked about.
    let mut tip = root.clone();
    for n in 0..40 {
        tip = h
            .commit(
                AGENT,
                Some(&tip),
                n + 1,
                json!([file("src/hot.rs", &format!("{n}"))]),
                json!([]),
            )
            .unwrap();
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":tip}));
    }
    branch(&h, "one", &tip, &["src/hot.rs"], json!([]));
    landing(&h, "one");
    let one = cost(&h);
    for n in 0..20 {
        let name = format!("l{n}");
        branch(&h, &name, &tip, &["src/hot.rs"], json!([]));
        landing(&h, &name);
    }
    let many = cost(&h);
    assert_eq!(one.statements, many.statements, "{one:?} {many:?}");
    assert!(
        one.statements <= none.statements + 5,
        "{none:?} then {one:?}"
    );
    // Rows answer for the Landings, not for the 40 commits of history on that file: each is
    // one open row, one commit walked and one path.
    assert!(
        many.rows <= none.rows + 3 * 21 + 2,
        "{none:?} then {many:?}"
    );
}
