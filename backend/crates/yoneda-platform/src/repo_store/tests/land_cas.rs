//! The land combiner: a batch lands with one compare-and-swap of the head it was built on.
//! The builder's lease is advisory, so a vanished builder never blocks the branch and a
//! late one is refused (and rebuilds) instead of landing on a moved head.
use super::*;

const MERGER: &str = "platform:merge";

#[test]
fn a_late_builder_loses_the_swap_and_a_vanished_one_never_blocks() {
    let (h, root) = seeded();
    let make = |path: &str| {
        let id = h
            .commit(AGENT, Some(&root), 1, json!([file(path, "x\n")]), json!([]))
            .unwrap();
        h.approve_and_check(&id);
        id
    };
    let (first, a, b) = (make("f.txt"), make("a.txt"), make("b.txt"));
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    let ta = h.ok(
        OWNER,
        json!({"op":"repo_land_enqueue","ref":"main","commit":a}),
    )["ticket"]
        .clone();
    let slow = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    assert_eq!(slow["head"], json!(first));
    // The slow builder vanishes; once its lease lapses another builder takes the batch.
    *h.now.borrow_mut() += 11_000;
    let fast = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    assert!(
        fast["items"].is_array(),
        "an expired lease does not block: {fast}"
    );
    let blob = |t: &str| yoneda_core::git_object::hash_object(ObjectKind::Blob, t.as_bytes());
    let merge = h
        .commit_with(
            MERGER,
            Some(&first),
            2,
            json!([{"path":"a.txt","blob":blob("x\n"),"type":"blob"}]),
            json!([]),
            json!({"merge_parents": [a]}),
        )
        .unwrap();
    h.ok(
        MERGER,
        json!({"op":"repo_land_batch","ref":"main","epoch":fast["epoch"],
        "head":fast["head"],"merge":merge,"landed":[ta]}),
    );
    // b queues behind (a landing that needs a merge joins the queue in the same call); the
    // slow builder returns with a batch built on the old head.
    let queued = h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":b,"enqueue":true}),
    );
    assert_eq!(queued["queued"], true);
    let tb = queued["ticket"].clone();
    let late = h.run(
        MERGER,
        json!({"op":"repo_land_batch","ref":"main","epoch":slow["epoch"],
        "head":slow["head"],"merge":merge,"landed":[tb]}),
    );
    assert_eq!(code(late), "STALE_HEAD");
    // Rebuilt on the new head, b lands with one more log entry.
    let again = h.ok(
        MERGER,
        json!({"op":"repo_land_claim","ref":"main","ticket":tb}),
    );
    assert_eq!(again["head"], json!(merge));
    let merge_b = h
        .commit_with(
            MERGER,
            Some(&merge),
            3,
            json!([{"path":"b.txt","blob":blob("x\n"),"type":"blob"}]),
            json!([]),
            json!({"merge_parents": [b]}),
        )
        .unwrap();
    let landed = h.ok(
        MERGER,
        json!({"op":"repo_land_batch","ref":"main","epoch":again["epoch"],
        "head":again["head"],"merge":merge_b,"landed":[tb]}),
    );
    assert_eq!(landed["version"], 4);
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_land_status","ticket":tb}))["status"],
        "landed"
    );
}
