//! A landing ticket for a commit already on its branch. Enqueueing one answers `already`
//! (no ticket), and a pending one left by earlier code settles as landed (already) when
//! its batch lands, instead of failing every batch and holding the branch's queue.
use super::batches::open;
use super::*;
use crate::storage::SqlStore;

const MERGER: &str = "platform:merge";

/// One combiner run: claim the queue and land its first fast-forward ticket alone.
fn land_fast_forward(h: &Harness) -> yoneda_core::Result<Value> {
    let claim = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    let item = claim["items"]
        .as_array()
        .and_then(|items| items.iter().find(|i| i["fast_forward"] == true))
        .cloned()
        .unwrap_or_else(|| panic!("no fast-forward item in {claim}"));
    h.run(
        MERGER,
        json!({"op":"repo_land_batch","ref":"main","epoch":claim["epoch"],"head":claim["head"],
            "landed":[item["ticket"]],"failed":[]}),
    )
}

/// Main still takes direct landings: nothing is left queued.
fn lands_directly(h: &Harness, parent: &str, version: u64) {
    let id = h
        .commit(
            AGENT,
            Some(parent),
            version,
            json!([file("next.txt", "next\n")]),
            json!([]),
        )
        .unwrap();
    let landed = h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    assert_eq!(landed["landed"], true, "{landed}");
}

#[test]
fn enqueueing_a_landed_commit_answers_already() {
    let (h, root) = open();
    let queued = h.ok(
        OWNER,
        json!({"op":"repo_land_enqueue","ref":"main","commit":root}),
    );
    assert_eq!(queued["already"], true, "{queued}");
    assert!(queued.get("ticket").is_none_or(Value::is_null), "{queued}");
    assert_eq!(
        h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}))["empty"],
        true
    );
    lands_directly(&h, &root, 1);
}

#[test]
fn a_pending_ticket_for_a_landed_commit_settles_and_frees_the_queue() {
    let (h, root) = open();
    // A queue as earlier code left it: a pending ticket for main's landed head.
    h.db.query(
        "INSERT INTO land_queue(refname,commit_id,principal,status,requested_at) VALUES('refs/heads/main',?,'user:owner','pending',0)",
        &[json!(root)],
    )
    .unwrap();
    let ticket = h.db.query("SELECT ticket FROM land_queue", &[]).unwrap()[0]["ticket"].clone();
    let landed = land_fast_forward(&h).unwrap();
    assert_eq!(landed["already"], true, "{landed}");
    let status = h.ok(OWNER, json!({"op":"repo_land_status","ticket":ticket}));
    assert_eq!(status["status"], "landed", "{status}");
    assert_eq!(status["result"]["already"], true, "{status}");
    // Nothing moved: main and the log are as they were.
    let refs = h.ok(OWNER, json!({"op":"repo_refs"}));
    assert_eq!(
        (
            refs["refs"]["refs/heads/main"].clone(),
            refs["version"].clone()
        ),
        (json!(root), json!(1))
    );
    lands_directly(&h, &root, 1);
}
