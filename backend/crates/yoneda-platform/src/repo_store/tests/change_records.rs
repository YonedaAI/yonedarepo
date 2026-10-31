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

#[test]
fn a_reader_with_no_cursor_starts_at_the_head_and_past_finished_tickets() {
    let (h, root) = seeded();
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("f.txt", "x\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&id);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    let stale = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("s.txt", "x\n")]),
            json!(["f.txt"]),
        )
        .unwrap();
    h.approve_and_check(&stale);
    let ticket = h.ok(
        OWNER,
        json!({"op":"repo_land_enqueue","ref":"main","commit":stale}),
    )["ticket"]
        .clone();
    let start = |h: &Harness| h.ok(DERIVE, json!({"op":"repo_change_records","from_head":true}));
    let waiting = start(&h);
    assert_eq!(waiting["records"], json!([]));
    assert_eq!(
        (&waiting["version"], &waiting["head_version"]),
        (&json!(2), &json!(2))
    );
    // A pending ticket is still ahead of the reader; a refused one is behind it.
    assert_eq!(waiting["ticket"].as_i64(), ticket.as_i64().map(|t| t - 1));
    h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    assert_eq!(start(&h)["ticket"], ticket);
}

/// Fields the adapter sets on every event, and the two it renames (`changeEvent`).
const ENVELOPE: [&str; 3] = ["schema", "event_key", "repo"];
const RENAMED: [(&str, &str); 2] = [
    ("occurred_at_ms", "occurred_at"),
    ("recorded_at_ms", "recorded_at"),
];

#[test]
fn records_and_the_stream_schema_agree() {
    // Basin accepts an event that does not match its stream and drops it later, silently,
    // so a disagreement here loses analytics with nothing to see at the send.
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../../../cloudflare/basin/change-log.schema.json"
    ))
    .unwrap();
    let fields: Vec<&Value> = schema["fields"].as_array().unwrap().iter().collect();
    let declared = |name: &str| fields.iter().find(|f| f["name"] == name);

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

    // Every key a land, merged and refused record carries is declared, with its type.
    let page = h.ok(DERIVE, json!({"op":"repo_change_records"}));
    for record in page["records"].as_array().unwrap() {
        for (key, value) in record.as_object().unwrap() {
            if value.is_null() {
                continue; // the adapter drops nulls
            }
            let renamed = RENAMED.iter().find(|(from, _)| from == key);
            let field = declared(renamed.map_or(key, |(_, to)| to))
                .unwrap_or_else(|| panic!("record field {key} is not in the stream schema"));
            let fits = match field["type"].as_str().unwrap() {
                "string" => value.is_string(),
                "int32" | "int64" => value.is_i64() || value.is_u64(),
                "timestamp" => value.is_i64(), // the adapter renders the milliseconds
                "list" => value.is_array(),
                other => panic!("no rule for schema type {other}"),
            };
            assert!(fits, "{key}={value} does not fit {}", field["type"]);
        }
    }
    // Every declared field is written by the records or the adapter: this fixture lands
    // no symbols or review class, so the source answers for the fields it does not reach.
    let source = include_str!("../change_records.rs");
    for field in &fields {
        let name = field["name"].as_str().unwrap();
        let written = ENVELOPE.contains(&name)
            || RENAMED.iter().any(|(_, to)| *to == name)
            || source.contains(&format!("\"{name}\""));
        assert!(written, "schema field {name} is written by no record");
    }
}

#[test]
fn a_record_read_again_keeps_its_key_and_shows_the_rows_as_they_are_now() {
    use super::compaction::{Store, compact_once, grow, run_archived};
    let (h, root) = seeded();
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("f.txt", "x\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&id);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    let page = |h: &Harness, r2: &Store| {
        let command = json!({"op":"repo_change_records","after_version":1,"limit":1});
        run_archived(h, DERIVE, r2, command).unwrap()["records"][0].clone()
    };
    let r2 = Store::default();
    let first = page(&h, &r2);
    assert_eq!(first["checks"], json!(["unit:pass"]));

    // Moving the version to a segment changes nothing: the entry comes back from R2, and
    // compaction leaves the commit's rows (it deletes log rows only).
    grow(&h, &root, &id, 1_200);
    h.ok(
        OWNER,
        json!({"op":"repo_set_retention","keep_versions":100,"keep_days":30}),
    );
    assert_eq!(compact_once(&h, &r2, json!({}))["floor"], 1_024);
    assert_eq!(page(&h, &r2), first);

    // A result recorded after the landing shows on the next read, under the same version
    // and commit: `changeEvent` gives it the same key, and consumers take one per key.
    h.ok(
        CI,
        json!({"op":"repo_check","commit":id,"name":"late","status":"fail"}),
    );
    let later = page(&h, &r2);
    assert_eq!(
        (&later["version"], &later["commit"]),
        (&first["version"], &first["commit"])
    );
    assert_eq!(later["checks"], json!(["late:fail", "unit:pass"]));
    assert_eq!(later["checks_failed"], 1);
}
