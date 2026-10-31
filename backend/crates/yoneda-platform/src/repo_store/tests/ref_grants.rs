//! A path grant covers moving a ref as it covers landing. A new ref may start at a commit
//! already on a branch; otherwise it, or a moved ref, holds only what the grant allows down
//! to where it meets its source: any branch for a new ref, the ref itself or a protected
//! ref for a moved one. What cannot be proved inside the grant is refused, as in landing.
use super::path_grants::{DOCS, MISSING, commit, repo};
use super::*;
use crate::repo_store::land_gates::WALK;
use crate::storage::SqlStore;

fn set(id: &str, refname: &str, expected: Value) -> Value {
    json!({"op":"repo_branch_set","ref":refname,"commit":id,"expected":expected})
}

fn batch(id: &str, refname: &str, expected: Value) -> Value {
    json!({"op":"repo_branch_batch","updates":[{"ref":refname,"commit":id,"expected":expected}]})
}

fn tag(id: &str, name: &str) -> Value {
    json!({"op":"repo_tag_create","name":name,"commit":id})
}

/// Every way a token creates a ref at `id` (each under its own name).
fn creations(id: &str, name: &str) -> [Value; 4] {
    [
        set(id, &format!("{name}-set"), Value::Null),
        batch(id, &format!("{name}-batch"), Value::Null),
        tag(id, &format!("{name}-tag")),
        batch(id, &format!("refs/tags/{name}-batched"), Value::Null),
    ]
}

/// Every way a token moves branch `refname` from `from` to `id`.
fn moves(id: &str, refname: &str, from: &str) -> [Value; 2] {
    [
        set(id, refname, json!(from)),
        batch(id, refname, json!(from)),
    ]
}

fn assert_refused(h: &Harness, commands: &[Value]) {
    for command in commands {
        let refused = h.run(DOCS, command.clone()).unwrap_err();
        assert_eq!(
            (refused.code.as_str(), refused.message.as_str()),
            ("FORBIDDEN", "Path is outside your grant"),
            "{command}"
        );
    }
}

fn assert_allowed(h: &Harness, commands: &[Value]) {
    for command in commands {
        assert_eq!(code(h.run(DOCS, command.clone())), "OK", "{command}");
    }
}

fn branch(h: &Harness, refname: &str, id: &str) {
    h.ok(AGENT, set(id, refname, Value::Null));
}

fn refs(h: &Harness) -> Value {
    h.ok(OWNER, json!({"op":"repo_refs"}))["refs"].clone()
}

#[test]
fn a_ref_is_not_made_at_a_commit_outside_the_grant() {
    let (h, root) = repo();
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    let head = commit(&h, DOCS, &src, "docs/a.md");
    let before = refs(&h);
    assert_refused(&h, &creations(&src, "outside"));
    assert_refused(&h, &creations(&head, "on-top"));
    assert_eq!(refs(&h), before);
    // Nothing changed for a caller of the whole repository.
    h.ok(AGENT, set(&head, "work", Value::Null));
}

#[test]
fn a_ref_starts_at_a_commit_already_on_a_branch() {
    let (h, root) = repo();
    // Main's head wrote src/, and this landing's history did too: neither is walked.
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":src}));
    assert_allowed(&h, &creations(&src, "at-main"));
    assert_allowed(&h, &creations(&root, "on-main"));
    // Under another branch's head, as well as at one.
    let other = commit(&h, AGENT, &src, "src/other.rs");
    let tip = commit(&h, AGENT, &other, "src/tip.rs");
    branch(&h, "feature", &tip);
    assert_allowed(&h, &creations(&tip, "at-feature"));
    assert_allowed(&h, &creations(&other, "in-feature"));
    // New work on top of a branch: the walk stops at the branch.
    let docs = commit(&h, DOCS, &other, "docs/a.md");
    assert_allowed(&h, &creations(&docs, "above"));
}

#[test]
fn a_commit_a_branch_only_once_held_is_not_on_it() {
    let (h, root) = repo();
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    h.ok(
        AGENT,
        json!({"op":"repo_land","ref":"feature","commit":src}),
    );
    h.ok(AGENT, set(&root, "feature", json!(src)));
    assert_refused(&h, &creations(&src, "gone"));
}

#[test]
fn a_moved_ref_is_judged_against_itself_and_protected_refs() {
    let (h, root) = repo();
    branch(&h, "work", &root);
    let inside = commit(&h, DOCS, &root, "docs/a.md");
    assert_allowed(&h, &[set(&inside, "work", json!(root))]);
    // A retried move has nothing to judge, whoever wrote the commit.
    assert_eq!(
        h.ok(DOCS, set(&inside, "work", json!(root)))["already"],
        true
    );

    // A branch's work is not another branch's to take on: it would bypass landing there.
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    let other = commit(&h, AGENT, &src, "src/other.rs");
    branch(&h, "feature", &other);
    let above = commit(&h, DOCS, &other, "docs/b.md");
    assert_refused(&h, &moves(&above, "work", &inside));
    assert_refused(&h, &moves(&other, "work", &inside));
    assert_eq!(refs(&h)["refs/heads/work"], json!(inside));

    // The shape a rebase leaves: new commits on main's head, whatever main holds.
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":other}));
    let rebased = commit(&h, DOCS, &other, "docs/a.md");
    assert_refused(&h, &moves(&other, "work", &inside));
    assert_allowed(&h, &[batch(&rebased, "work", json!(inside))]);
}

#[test]
fn a_ref_move_fails_closed_as_a_landing_does() {
    let (h, root) = repo();
    let mut commands = Vec::new();
    branch(&h, "work", &root);
    // A merge, as the head and on the way.
    let side = commit(&h, DOCS, &root, "docs/side.md");
    let merge = h
        .commit_with(
            DOCS,
            Some(&root),
            1,
            json!([file("docs/m.md", "x\n")]),
            json!([]),
            json!({"merge_parent": side}),
        )
        .unwrap();
    let above = commit(&h, DOCS, &merge, "docs/above.md");
    // A parent not recorded, and a commit with no recorded paths.
    let lost = commit(&h, DOCS, &root, "docs/lost.md");
    let on_lost = commit(&h, DOCS, &lost, "docs/on-lost.md");
    let blank = commit(&h, DOCS, &root, "docs/blank.md");
    let on_blank = commit(&h, DOCS, &blank, "docs/on-blank.md");
    h.db.query("DELETE FROM commits WHERE id=?", &[json!(lost)])
        .unwrap();
    h.db.query(
        "DELETE FROM commit_paths WHERE commit_id=?",
        &[json!(blank)],
    )
    .unwrap();
    for (i, id) in [&merge, &above, &on_lost, &blank, &on_blank]
        .into_iter()
        .enumerate()
    {
        commands.extend(creations(id, &format!("closed-{i}")));
        commands.extend(moves(id, "work", &root));
    }
    assert_refused(&h, &commands);
}

#[test]
fn a_ref_move_walks_a_bounded_chain() {
    let (h, root) = repo();
    let mut tip = root;
    for i in 0..WALK {
        tip = commit(&h, DOCS, &tip, &format!("docs/{i}.md"));
    }
    let past = commit(&h, DOCS, &tip, "docs/past.md");
    assert_refused(&h, &creations(&past, "past"));
    assert_allowed(&h, &creations(&tip, "at-bound"));
}

#[test]
fn a_commit_not_here_yet_is_left_for_the_adapter_to_adopt() {
    let (h, _) = repo();
    for command in [
        set(MISSING, "work", Value::Null),
        batch(MISSING, "work", Value::Null),
        tag(MISSING, "v1"),
    ] {
        assert_eq!(code(h.run(DOCS, command.clone())), "NOT_FOUND", "{command}");
    }
}

#[test]
fn deleting_a_ref_brings_nothing() {
    let (h, root) = repo();
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    branch(&h, "work", &src);
    let delete = json!({"op":"repo_branch_batch",
        "updates":[{"ref":"work","commit":null,"expected":src}]});
    assert_allowed(&h, &[delete]);
}

#[test]
fn an_oversized_batch_is_refused_before_any_walk() {
    let (h, root) = repo();
    let update = json!({"ref":"work","commit":root,"expected":null});
    let updates = vec![update; 101];
    let (sql, refused) = (
        h.db.counts(),
        h.run(DOCS, json!({"op":"repo_branch_batch","updates":updates})),
    );
    assert_eq!(code(refused), "INVALID_INPUT");
    assert!((h.db.counts() - sql).statements < 20);
}
