//! Changes to a base other than main: the base must be another existing branch, show says
//! whether landing on it is gated, landing the head on the base (by `repo_land` with only
//! `write`, or by moving the base branch to it) lands the change and leaves main alone, a
//! change on one base is not landed by its head reaching another, and a change whose base
//! was deleted does not reopen.
use super::*;

/// A commit on `parent` touching `path`, with `branch` created at it.
fn branch(h: &Harness, name: &str, parent: &str, path: &str) -> String {
    let id = h
        .commit(
            AGENT,
            Some(parent),
            1,
            json!([file(path, "x\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":name,"commit":id,"expected":null}),
    );
    id
}

fn open(h: &Harness, branch: &str, base: Option<&str>) -> yoneda_core::Result<Value> {
    let mut c = json!({"op":"repo_change_create","branch":branch,"title":"Stage it"});
    if let Some(base) = base {
        c["base"] = json!(base);
    }
    h.run(AGENT, c)
}

fn show(h: &Harness, number: &Value) -> Value {
    h.ok(CI, json!({"op":"repo_change_show","number":number}))
}

#[test]
fn a_change_lands_on_its_own_base_branch() {
    let (h, root) = seeded();
    let main = h.ok(CI, json!({"op":"repo_refs"}))["refs"]["refs/heads/main"].clone();
    let base = branch(&h, "stage", &root, "docs/stage.md");
    let head = branch(&h, "fix", &base, "src/fix.rs");

    assert_eq!(code(open(&h, "fix", Some("nope"))), "NOT_FOUND");
    assert_eq!(code(open(&h, "fix", Some("fix"))), "INVALID_INPUT");
    assert_eq!(code(open(&h, "fix", Some("bad..name"))), "INVALID_INPUT");
    let change = open(&h, "fix", Some("refs/heads/stage")).unwrap();
    assert_eq!(
        (&change["base"], &change["head"]),
        (&json!("stage"), &json!(head))
    );
    let shown = show(&h, &change["number"]);
    assert_eq!(shown["base_protected"], false);
    assert_eq!(shown["head_commit"]["gates"]["ready"], false);

    // The head is neither approved nor checked: an unprotected base takes it with `write`.
    let landed = h.ok(AGENT, json!({"op":"repo_land","ref":"stage","commit":head}));
    let shown = show(&h, &change["number"]);
    assert_eq!(
        (
            &shown["status"],
            &shown["landed_commit"],
            &shown["landed_version"]
        ),
        (&json!("landed"), &json!(head), &landed["version"])
    );
    let refs = h.ok(CI, json!({"op":"repo_refs"}))["refs"].clone();
    assert_eq!(refs["refs/heads/main"], main, "main did not move");

    // Default base main: gated, and not landed by its head reaching another branch.
    let other = branch(&h, "other", &root, "src/other.rs");
    let to_main = open(&h, "other", None).unwrap();
    assert_eq!(to_main["base"], "main");
    assert_eq!(show(&h, &to_main["number"])["base_protected"], true);
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"stage","commit":other,"expected":head}),
    );
    assert_eq!(show(&h, &to_main["number"])["status"], "open");
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_land","ref":"main","commit":other}))),
        "FORBIDDEN"
    );
}

#[test]
fn moving_the_base_branch_to_the_head_lands_the_change() {
    let (h, root) = seeded();
    let base = branch(&h, "stage", &root, "docs/stage.md");
    let head = branch(&h, "fix", &base, "src/fix.rs");
    let change = open(&h, "fix", Some("stage")).unwrap();
    let moved = h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"stage","commit":head,"expected":base}]}),
    );
    let shown = show(&h, &change["number"]);
    assert_eq!(
        (&shown["status"], &shown["landed_version"]),
        (&json!("landed"), &moved["version"])
    );
}

#[test]
fn a_change_whose_base_is_gone_does_not_reopen() {
    let (h, root) = seeded();
    let base = branch(&h, "stage", &root, "docs/stage.md");
    branch(&h, "fix", &root, "src/fix.rs");
    let number = open(&h, "fix", Some("stage")).unwrap()["number"].clone();
    h.ok(AGENT, json!({"op":"repo_change_close","number":number}));
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"stage","commit":null,"expected":base}]}),
    );
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_change_reopen","number":number}))),
        "NOT_FOUND"
    );
}
