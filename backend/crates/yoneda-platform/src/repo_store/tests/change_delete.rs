//! Deleting a change request: only a closed one (an open change is closed first, a landed
//! one stays as history), only by its author or the owner, taking its comments with it.
//! `change` hooks get `change.deleted`; the number is never reused and landed history,
//! the branch and its commits are untouched.
use super::*;
use crate::storage::SqlStore;

fn token(h: &Harness, name: &str, scopes: Value) {
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":name,"scopes":scopes,
        "_secret":format!("{name}-secret-0123456789abcdef0123456789")}),
    );
}

/// `branch` at a new commit on `parent`, with an open change on it by `who`.
fn change_on(h: &Harness, who: &str, branch: &str, parent: &str) -> (String, i64) {
    let id = h
        .commit(
            AGENT,
            Some(parent),
            1,
            json!([file(&format!("{branch}.txt"), "x\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":branch,"commit":id,"expected":null}),
    );
    let change = h.ok(
        who,
        json!({"op":"repo_change_create","branch":branch,"title":"Try it","body":"Draft."}),
    );
    (id, change["number"].as_i64().unwrap())
}

fn delete(h: &Harness, who: &str, number: i64) -> String {
    code(h.run(who, json!({"op":"repo_change_delete","number":number})))
}

#[test]
fn only_closed_changes_are_deleted_by_their_author_or_the_owner() {
    let (h, root) = seeded();
    token(&h, "lander", json!(["read", "write", "land"]));
    let hook = h.ok(
        OWNER,
        json!({"op":"repo_hook_create","url":"https://ci.example.com/hook",
        "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":"r0123456789abcdef0123",
        "_workers_subdomain":"mlong-f01","events":["change"]}),
    )["id"]
        .clone();
    let (head, number) = change_on(&h, AGENT, "try", &root);
    h.ok(
        OWNER,
        json!({"op":"repo_change_comment","number":number,"body":"Hmm."}),
    );

    // Open: close it first. Not the author or the owner: refused, even for a lander.
    assert_eq!(delete(&h, AGENT, number), "CONFLICT");
    h.ok(AGENT, json!({"op":"repo_change_close","number":number}));
    assert_eq!(delete(&h, "token:lander", number), "FORBIDDEN");
    assert_eq!(delete(&h, CI, number), "FORBIDDEN");
    let deleted = h.ok(AGENT, json!({"op":"repo_change_delete","number":number}));
    assert_eq!(deleted, json!({"number": number, "deleted": true}));
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_change_show","number":number}))),
        "NOT_FOUND"
    );
    assert_eq!(delete(&h, AGENT, number), "NOT_FOUND");
    let comments =
        h.db.query(
            "SELECT id FROM change_comments WHERE change_number=?",
            &[json!(number)],
        )
        .unwrap();
    assert!(comments.is_empty());
    // The branch and its commit stay; the next change takes a new number.
    let refs = h.ok(AGENT, json!({"op":"repo_refs"}))["refs"].clone();
    assert_eq!(refs["refs/heads/try"], json!(head));
    let again = h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"try","title":"Again"}),
    );
    assert_eq!(again["number"], json!(number + 1));
    // The owner deletes anyone's closed change.
    h.ok(OWNER, json!({"op":"repo_change_close","number":number + 1}));
    h.ok(
        OWNER,
        json!({"op":"repo_change_delete","number":number + 1}),
    );

    // The event names the change and who deleted it.
    h.ok("platform:hooks", json!({"op":"repo_hooks_fanout"}));
    let events: Vec<Value> =
        h.db.query(
            "SELECT payload FROM hook_outbox WHERE hook_id=? ORDER BY seq",
            &[hook],
        )
        .unwrap()
        .iter()
        .map(|r| serde_json::from_str(r["payload"].as_str().unwrap()).unwrap())
        .filter(|e: &Value| e["event"] == "change.deleted")
        .collect();
    assert_eq!(events.len(), 2);
    assert_eq!(
        (
            &events[0]["actor"],
            &events[0]["action"],
            &events[0]["change"]["number"]
        ),
        (&json!(AGENT), &json!("deleted"), &json!(number))
    );
}

#[test]
fn landed_changes_stay_as_history() {
    let (h, root) = seeded();
    let (head, number) = change_on(&h, AGENT, "fix", &root);
    h.approve_and_check(&head);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":head}));
    assert_eq!(delete(&h, OWNER, number), "CONFLICT");
    let shown = h.ok(CI, json!({"op":"repo_change_show","number":number}));
    assert_eq!(shown["status"], "landed");
}
