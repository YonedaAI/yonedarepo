//! Change records: every landed version, each commit a merge landed and each refused
//! queued landing, resumable by cursor and readable only by the platform's derive job.
use super::*;

const DERIVE: &str = "platform:derive";
const MERGER: &str = "platform:merge";

#[test]
fn change_records_cover_lands_merges_and_refusals_by_cursor() {
    let (h, root) = seeded();
    let make = |path: &str, read: Value| {
        let id = h
            .commit(AGENT, Some(&root), 1, json!([file(path, "x\n")]), read)
            .unwrap();
        h.approve_and_check(&id);
        id
    };
    let (first, a, b, stale) = (
        make("f.txt", json!([])),
        make("a.txt", json!(["src/"])),
        make("b.txt", json!([])),
        make("s.txt", json!(["f.txt"])),
    );
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    let tickets: Vec<Value> = [&a, &b, &stale]
        .iter()
        .map(|c| {
            h.ok(
                OWNER,
                json!({"op":"repo_land_enqueue","ref":"main","commit":c}),
            )["ticket"]
                .clone()
        })
        .collect();
    let claim = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    let blob = |t: &str| yoneda_core::git_object::hash_object(ObjectKind::Blob, t.as_bytes());
    let merge = h
        .commit_with(MERGER, Some(&first), 2,
            json!([{"path":"a.txt","blob":blob("x\n"),"type":"blob"},{"path":"b.txt","blob":blob("x\n"),"type":"blob"}]),
            json!([]), json!({"merge_parents": [a, b]}))
        .unwrap();
    h.ok(MERGER, json!({"op":"repo_land_batch","ref":"main","epoch":claim["epoch"],"head":claim["head"],"merge":merge,"landed":[tickets[0], tickets[1]]}));

    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_change_records"}))),
        "FORBIDDEN"
    );
    let page = h.ok(DERIVE, json!({"op":"repo_change_records"}));
    assert_eq!(
        (page["version"].clone(), page["ticket"].clone()),
        (json!(3), tickets[2].clone())
    );
    let records = page["records"].as_array().unwrap();
    let events: Vec<(&str, Option<u64>)> = records
        .iter()
        .map(|r| (r["event"].as_str().unwrap(), r["version"].as_u64()))
        .collect();
    assert_eq!(
        events,
        [
            ("land", Some(1)),
            ("land", Some(2)),
            ("land", Some(3)),
            ("merged", Some(3)),
            ("merged", Some(3)),
            ("refused", None)
        ]
    );
    let direct = &records[1];
    assert_eq!(direct["commit"], json!(first));
    assert_eq!(direct["parents"], json!([root]));
    assert_eq!(
        (direct["actor"].as_str(), direct["actor_kind"].as_str()),
        (Some(OWNER), Some("user"))
    );
    assert_eq!(
        (direct["writer"].as_str(), direct["paths_changed"].as_u64()),
        (Some(AGENT), Some(1))
    );
    assert_eq!(
        (direct["checks"].clone(), direct["checks_passed"].clone()),
        (json!(["unit:pass"]), json!(1))
    );
    assert!(direct["land_latency_ms"].as_i64().unwrap() > 0);
    let batch = &records[2];
    assert_eq!(
        (batch["kind"].as_str(), batch["merged_landings"].as_u64()),
        (Some("merge"), Some(2))
    );
    assert_eq!(batch["actor"], json!(MERGER));
    assert_eq!(
        batch["read_set_size"],
        json!(1),
        "the merge carries its landings' read sets"
    );
    for record in &records[3..5] {
        assert!(record["commit"] == json!(a) || record["commit"] == json!(b));
        assert_eq!(
            (record["actor"].as_str(), record["writer"].as_str()),
            (Some(OWNER), Some(AGENT))
        );
        assert!(record["queue_wait_ms"].as_i64().unwrap() > 0);
    }
    let refused = &records[5];
    assert_eq!(
        (refused["commit"].clone(), refused["error_code"].as_str()),
        (json!(stale), Some("CONFLICT"))
    );
    // Records carry identifiers and counts only: no messages, paths or contents.
    let text = page.to_string();
    for leaked in ["message", "f.txt", "content", "secret"] {
        assert!(!text.contains(leaked), "{leaked} leaked");
    }

    let resumed = h.ok(
        DERIVE,
        json!({"op":"repo_change_records","after_version":3,"after_ticket":page["ticket"]}),
    );
    assert_eq!(resumed["records"], json!([]));
    let limited = h.ok(
        DERIVE,
        json!({"op":"repo_change_records","after_version":1,"limit":1}),
    );
    assert_eq!(limited["version"], 2);
}
