//! A change's instruments read: the last heads of its branch with what each one's check
//! evidence says and what the Risk score needs from the authority, bounded, whichever
//! change on the branch is asked about, and readable by whoever may read the change.
use super::*;

const POSTER: &str = "token:ci";

fn push(h: &Harness, branch: &str, parent: &str, path: &str) -> String {
    let id = h
        .commit(
            AGENT,
            Some(parent),
            1,
            json!([file(path, &format!("{parent}\n"))]),
            json!([]),
        )
        .unwrap();
    let current =
        h.ok(AGENT, json!({"op":"repo_refs"}))["refs"][format!("refs/heads/{branch}")].clone();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":branch,"commit":id,"expected":current}]}),
    );
    id
}

fn open(h: &Harness, branch: &str) -> i64 {
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":branch,"title":"Retry"}),
    )["number"]
        .as_i64()
        .unwrap()
}

fn read(h: &Harness, number: i64) -> Value {
    h.ok(CI, json!({"op":"repo_change_instruments","number":number}))
}

fn commits(facts: &Value) -> Vec<String> {
    facts["heads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["commit"].as_str().unwrap().to_owned())
        .collect()
}

fn post(h: &Harness, commit: &str, name: &str, evidence: Value) {
    h.ok(
        POSTER,
        json!({"op":"repo_check","commit":commit,"name":name,"status":"pass","evidence":evidence}),
    );
}

fn classify(h: &Harness, id: &str, class: &str) {
    h.ok(
        "platform:derive",
        json!({"op":"repo_record_classes","commit":id,"overall":class,
            "files":[{"path":"src/x.rs","class":class}]}),
    );
}

#[test]
fn reads_the_last_five_heads_newest_first_with_their_check_values() {
    let (h, root) = seeded();
    let mut pushed = Vec::new();
    let mut at = root.clone();
    for n in 0..7 {
        at = push(&h, "fix", &at, &format!("src/f{n}.rs"));
        pushed.push(at.clone());
    }
    let number = open(&h, "fix");
    for (n, value) in [(6, "medium"), (5, "low")] {
        post(&h, &pushed[n], "slop-review", json!({"value": value}));
    }

    let facts = read(&h, number);
    let newest: Vec<String> = pushed.iter().rev().take(5).cloned().collect();
    assert_eq!(commits(&facts), newest);
    assert_eq!(facts["heads"][0]["checks"][0]["name"], "slop-review");
    assert_eq!(facts["heads"][0]["checks"][0]["value"], "medium");
    assert_eq!(facts["heads"][1]["checks"][0]["value"], "low");
    assert_eq!(facts["heads"][2]["checks"], json!([]));
    assert!(facts["heads"][0]["at"].as_i64().unwrap() > 0);
}

#[test]
fn a_head_pushed_again_counts_once() {
    let (h, root) = seeded();
    let first = push(&h, "fix", &root, "src/a.rs");
    let second = push(&h, "fix", &first, "src/b.rs");
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"fix","commit":first,"expected":second}]}),
    );
    let moved = h.ok(AGENT, json!({"op":"repo_refs"}))["refs"]["refs/heads/fix"].clone();
    let number = open(&h, "fix");
    let facts = read(&h, number);
    assert_eq!(facts["heads"][0]["commit"], moved);
    let listed = commits(&facts);
    let mut unique = listed.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), listed.len());
}

#[test]
fn only_a_recognised_value_is_read_and_the_newest_result_wins() {
    let (h, root) = seeded();
    let head = push(&h, "fix", &root, "src/a.rs");
    let number = open(&h, "fix");
    post(&h, &head, "ci", json!("plain text, not JSON"));
    post(&h, &head, "odd", json!({"value": "<script>"}));
    post(&h, &head, "slop-review", json!({"value": "high"}));
    // A policy change keeps the old row under its digest; the newest result is the reading.
    h.ok(
        OWNER,
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}}),
    );
    post(&h, &head, "slop-review", json!({"value": "low"}));

    let facts = read(&h, number);
    let checks = facts["heads"][0]["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 1, "{checks:?}");
    assert_eq!(
        (&checks[0]["name"], &checks[0]["value"]),
        (&json!("slop-review"), &json!("low"))
    );
    assert!(checks[0].get("evidence").is_none());
}

#[test]
fn open_findings_are_unresolved_line_comments_and_withheld_findings() {
    let (h, root) = seeded();
    let first = push(&h, "fix", &root, "src/a.rs");
    let second = push(&h, "fix", &first, "src/b.rs");
    let number = open(&h, "fix");
    let comment = |commit: &str, line: u32, resolve: bool| {
        h.ok(
            AGENT,
            json!({"op":"repo_change_comment","number":number,"body":"why","commit":commit,
                   "path":"src/b.rs","line":line,"side":"new","resolve":resolve}),
        )
    };
    comment(&first, 1, false);
    comment(&second, 1, false);
    comment(&second, 2, false);
    h.ok(
        AGENT,
        json!({"op":"repo_change_comment","number":number,"body":"general"}),
    );
    post(
        &h,
        &second,
        "code-review",
        json!({"value":"fail","withheld":{"high":1,"medium":1,"low":"many"}}),
    );

    let facts = read(&h, number);
    // The newest head carries every comment still open; an older head only its own.
    assert_eq!(facts["heads"][0]["open_findings"], 5);
    assert_eq!(facts["heads"][1]["open_findings"], 1);
}

#[test]
fn commit_facts_cover_every_commit_of_the_change_and_never_hide_one() {
    let (h, root) = seeded();
    let first = push(&h, "fix", &root, "src/a.rs");
    let second = push(&h, "fix", &first, "src/b.rs");
    let third = push(&h, "fix", &second, "src/c.rs");
    classify(&h, &first, "logic");
    classify(&h, &third, "docs");
    let number = open(&h, "fix");

    let facts = read(&h, number);
    let head = &facts["heads"][0];
    assert_eq!(head["commits"]["classes"], json!({"docs":1,"logic":1}));
    assert_eq!(head["commits"]["unclassified"], 1);
    assert_eq!(head["commits"]["unread"], false);
    // The diff's own comparison: the merge base's tree.
    let base = h.ok(CI, json!({"op":"repo_commit","commit":root}));
    assert_eq!(head["compared"]["base_tree"], base["tree"]);
}

#[test]
fn a_merge_in_the_branch_is_reported_unread() {
    let (h, root) = seeded();
    let first = push(&h, "fix", &root, "src/a.rs");
    let side = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/side.rs", "x\n")]),
            json!([]),
        )
        .unwrap();
    let merge = h
        .commit_with(
            AGENT,
            Some(&first),
            1,
            json!([file("src/a.rs", "merged\n")]),
            json!([]),
            json!({"merge_parent": side}),
        )
        .unwrap();
    let current = h.ok(AGENT, json!({"op":"repo_refs"}))["refs"]["refs/heads/fix"].clone();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"fix","commit":merge,"expected":current}]}),
    );
    let number = open(&h, "fix");
    assert_eq!(read(&h, number)["heads"][0]["commits"]["unread"], true);
}

#[test]
fn a_landed_change_keeps_its_own_heads_and_its_base_from_before_it_landed() {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}}),
    );
    let first = push(&h, "fix", &root, "src/a.rs");
    let number = open(&h, "fix");
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    // The branch moves on: a new change, which must not read the landed one's head.
    let later = push(&h, "fix", &first, "src/b.rs");
    let next = open(&h, "fix");

    let landed = read(&h, number);
    assert_eq!(commits(&landed), vec![first.clone()]);
    let base = h.ok(CI, json!({"op":"repo_commit","commit":root}));
    assert_eq!(landed["heads"][0]["compared"]["base_tree"], base["tree"]);
    assert_eq!(landed["heads"][0]["commits"]["unclassified"], 1);
    assert_eq!(commits(&read(&h, next)), vec![later]);
}

#[test]
fn a_deleted_branch_has_no_heads() {
    let (h, root) = seeded();
    let head = push(&h, "fix", &root, "src/a.rs");
    let number = open(&h, "fix");
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"fix","commit":null,"expected":head}]}),
    );
    assert_eq!(read(&h, number)["heads"], json!([]));
}

#[test]
fn who_may_read_it() {
    let (h, root) = seeded();
    let head = push(&h, "fix", &root, "src/a.rs");
    let number = open(&h, "fix");
    post(&h, &head, "slop-review", json!({"value": "low"}));
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
               "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(h.run(
            "token:docs",
            json!({"op":"repo_change_instruments","number":number})
        )),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_change_instruments","number":9}))),
        "NOT_FOUND"
    );
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":"public"}),
    );
    let anonymous = h.ok(
        "user:nobody",
        json!({"op":"repo_change_instruments","number":number,"_anonymous":true}),
    );
    assert_eq!(anonymous["heads"][0]["checks"][0]["value"], "low");
}
