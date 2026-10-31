//! History filled in behind an imported head (`history_fill`): the head lands first, then
//! its ancestors arrive newest first. Until the oldest has, every read of history says it
//! is partial and nothing moves a ref; once it has, the repository holds exactly what
//! recording oldest first and landing last would have left.
use super::*;
use crate::repo_store::history_fill::Imported;
use crate::storage::SqlStore;

const IMPORTER: &str = "platform:import";

fn id(n: usize) -> String {
    format!("{n:040x}")
}
fn blob(n: usize) -> String {
    format!("b{n:039x}")
}

/// Commit `n` of `newest` (1 is the oldest), touching one file and one of its own.
fn commit(n: usize, newest: usize, boundary: bool) -> Value {
    let parents = match (n, boundary) {
        (1, false) => json!([]),
        (1, true) => json!([id(9_999)]),
        _ => json!([id(n - 1)]),
    };
    json!({
        "commit": id(n), "tree": format!("{n:040x}").replace('0', "d"), "parents": parents,
        "message": format!("change {n}"), "generation": n,
        "touches": [
            {"path":"shared.txt","op":"modify","old_blob":blob(n - 1),"new_blob":blob(n)},
            {"path":format!("dir/n{n}.txt"),"op":"add","old_blob":null,"new_blob":blob(n)},
        ],
        "total": newest,
    })
}

/// A repository whose head of `total` commits has landed, history still to come.
fn landed(total: usize, boundary: bool) -> Harness {
    let h = Harness::new();
    let mut head = commit(total, total, boundary);
    head["op"] = json!("repo_record_imported");
    h.ok(IMPORTER, head);
    h.ok(
        IMPORTER,
        json!({"op":"repo_import","ref":"main","commit":id(total)}),
    );
    h
}

fn fill(h: &Harness, newest: usize, oldest: usize, total: usize, boundary: bool) -> Value {
    let commits: Vec<Value> = (oldest..=newest)
        .rev()
        .map(|n| commit(n, total, boundary))
        .collect();
    h.ok(
        IMPORTER,
        json!({"op":"repo_record_imported_batch","commits":commits}),
    )
}

/// The same history as today's import records it: oldest first, landed last.
fn recorded_oldest_first(total: usize, boundary: bool) -> Harness {
    let h = Harness::new();
    for n in 1..=total {
        let mut c = commit(n, total, boundary);
        c["op"] = json!("repo_record_imported");
        c.as_object_mut().unwrap().remove("generation");
        h.ok(IMPORTER, c);
    }
    h.ok(
        IMPORTER,
        json!({"op":"repo_import","ref":"main","commit":id(total)}),
    );
    h
}

/// An answer without the times its repository happened to be written at.
fn undated(answer: Value) -> Value {
    match answer {
        Value::Object(fields) => fields
            .into_iter()
            .filter(|(key, _)| !["landed_at", "recorded_at"].contains(&key.as_str()))
            .map(|(key, value)| (key, undated(value)))
            .collect(),
        Value::Array(items) => items.into_iter().map(undated).collect(),
        other => other,
    }
}

fn history_import(h: &Harness) -> Value {
    h.ok(OWNER, json!({"op":"repo_status"}))["history_import"].clone()
}

#[test]
fn a_filled_history_is_exactly_the_history_recorded_oldest_first() {
    for boundary in [false, true] {
        let (fast, slow) = (landed(6, boundary), recorded_oldest_first(6, boundary));
        fill(&fast, 5, 3, 6, boundary);
        fill(&fast, 2, 1, 6, boundary);
        assert_eq!(history_import(&fast), Value::Null);
        for query in [
            "SELECT id,tree,parents,generation,message,principal,origin,read_set,base_version FROM commits ORDER BY rowid",
            "SELECT commit_id,path,op,old_blob,new_blob,mode FROM commit_paths ORDER BY commit_id,path",
            "SELECT ref,depth,commit_id FROM ref_chain ORDER BY depth",
        ] {
            assert_eq!(
                fast.db.query(query, &[]).unwrap(),
                slow.db.query(query, &[]).unwrap(),
                "{query}"
            );
        }
        for c in [
            json!({"op":"repo_log","ref":"main"}),
            json!({"op":"repo_path_history","ref":"main","path":"shared.txt"}),
            json!({"op":"repo_path_history","ref":"main","path":"dir/n2.txt"}),
            json!({"op":"repo_search_records","query":"change"}),
        ] {
            assert_eq!(
                undated(fast.ok(OWNER, c.clone())),
                undated(slow.ok(OWNER, c.clone())),
                "{c}"
            );
        }
    }
}

#[test]
fn a_filling_history_reads_as_partial_never_complete() {
    let h = landed(5, false);
    assert_eq!(history_import(&h), json!({"recorded":1,"total":5}));
    let reads = |h: &Harness| {
        for c in [
            json!({"op":"repo_log","ref":"main"}),
            json!({"op":"repo_path_history","ref":"main","path":"shared.txt"}),
            json!({"op":"repo_search_records","query":"change"}),
        ] {
            assert_eq!(
                h.ok(OWNER, c.clone())["history_import"],
                history_import(h),
                "{c}"
            );
        }
    };
    reads(&h);
    let unrecorded = h
        .run(OWNER, json!({"op":"repo_commit","commit":id(2)}))
        .unwrap_err();
    assert_eq!(unrecorded.code, "NOT_FOUND");
    assert!(
        unrecorded.to_string().contains("still importing (1 of 5"),
        "{unrecorded}"
    );

    // The newest commits arrive first, so what shows is the top of the real history.
    let answer = fill(&h, 4, 3, 5, false);
    assert_eq!(answer["recorded"], 2);
    assert_eq!(answer["history_import"], json!({"recorded":3,"total":5}));
    reads(&h);
    let log = h.ok(OWNER, json!({"op":"repo_log","ref":"main"}));
    let listed: Vec<&str> = log["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["commit"].as_str().unwrap())
        .collect();
    assert_eq!(listed, [id(5), id(4), id(3)]);
    let touches = h.ok(
        OWNER,
        json!({"op":"repo_path_history","ref":"main","path":"shared.txt"}),
    );
    assert_eq!(touches["commits"].as_array().unwrap().len(), 3);

    fill(&h, 2, 1, 5, false);
    let done = h.ok(OWNER, json!({"op":"repo_log","ref":"main"}));
    assert_eq!(done["commits"].as_array().unwrap().len(), 5);
    assert!(done.get("history_import").is_none());
}

#[test]
fn nothing_moves_a_ref_or_starts_new_history_while_filling() {
    let h = landed(3, false);
    let change = file("x.txt", "x\n");
    for (principal, command) in [
        (
            AGENT,
            json!({"op":"repo_prepare_commit","ref":"main","changes":[change]}),
        ),
        (
            AGENT,
            json!({"op":"repo_begin_commit","ref":"main","paths":["x.txt"]}),
        ),
        (AGENT, json!({"op":"repo_record_pushed","commits":[]})),
        (OWNER, json!({"op":"repo_land","ref":"main","commit":id(3)})),
        (
            AGENT,
            json!({"op":"repo_branch_set","ref":"work","commit":id(3)}),
        ),
        (
            OWNER,
            json!({"op":"repo_tag_create","name":"v1","commit":id(3)}),
        ),
        (OWNER, json!({"op":"repo_fork_source"})),
        (CI, json!({"op":"repo_git_walk","wants":[id(3)],"haves":[]})),
    ] {
        let refused = h.run(principal, command.clone()).unwrap_err();
        assert_eq!(refused.code, "IMPORT_IN_PROGRESS", "{command}");
        assert!(refused.to_string().contains("1 of 3"), "{refused}");
    }
    // Reading the head and asking how far it got keep working.
    h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}));

    fill(&h, 2, 1, 3, false);
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"work","commit":id(3)}),
    );
    let log = h.ok(CI, json!({"op":"repo_git_walk","wants":[id(3)],"haves":[]}));
    assert_eq!(log["commits"].as_array().unwrap().len(), 3);
}

#[test]
fn a_retried_or_overlapping_batch_records_nothing_twice() {
    let h = landed(6, false);
    assert_eq!(fill(&h, 5, 4, 6, false)["recorded"], 2);
    assert_eq!(fill(&h, 5, 4, 6, false)["recorded"], 0);
    // An answer lost: the next attempt starts above where the last one reached.
    assert_eq!(fill(&h, 5, 2, 6, false)["recorded"], 2);
    let rows =
        h.db.query("SELECT COUNT(*) AS n FROM commit_paths", &[])
            .unwrap();
    assert_eq!(rows[0]["n"], 10);
    assert_eq!(fill(&h, 1, 1, 6, false)["recorded"], 1);
    // After the end, a late retry changes nothing.
    let late = fill(&h, 3, 1, 6, false);
    assert_eq!(late["recorded"], 0);
    assert_eq!(late["history_import"], Value::Null);
    // The head's own record repeats as today's does.
    let mut again = commit(6, 6, false);
    again["op"] = json!("repo_record_imported");
    assert_eq!(h.ok(IMPORTER, again)["already"], true);
}

#[test]
fn a_batch_must_continue_the_chain_it_fills() {
    let h = landed(6, false);
    let batch = |commits: Vec<Value>| {
        h.run(
            IMPORTER,
            json!({"op":"repo_record_imported_batch","commits":commits}),
        )
    };
    // Skipping a commit would leave a hole the chain could never close.
    assert_eq!(code(batch(vec![commit(4, 6, false)])), "CONFLICT");
    let mut forged = commit(5, 6, false);
    forged["commit"] = json!(id(77));
    assert_eq!(code(batch(vec![forged])), "CONFLICT");
    let mut root = commit(5, 6, false);
    root["parents"] = json!([]);
    assert_eq!(code(batch(vec![root])), "INVALID_INPUT");
    assert_eq!(history_import(&h), json!({"recorded":1,"total":6}));
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_record_imported_batch","commits":[]})
        )),
        "FORBIDDEN"
    );
    // A repository nothing landed in has no chain to fill.
    let empty = Harness::new();
    assert_eq!(
        code(empty.run(
            IMPORTER,
            json!({"op":"repo_record_imported_batch","commits":[commit(1, 1, false)]})
        )),
        "NOT_FOUND"
    );
}

#[test]
fn an_imported_repository_landed_whole_never_reads_as_filling() {
    assert_eq!(
        history_import(&recorded_oldest_first(4, false)),
        Value::Null
    );
    assert_eq!(history_import(&recorded_oldest_first(4, true)), Value::Null);
    assert_eq!(history_import(&landed(1, false)), Value::Null);
    assert_eq!(history_import(&landed(1, true)), Value::Null);
    // A chain's first commit keeps its generation, here the start of history.
    let (h, _) = super::batches::open();
    assert_eq!(history_import(&h), Value::Null);
}

#[test]
fn commits_order_as_if_recorded_oldest_first() {
    let h = landed(3, false);
    fill(&h, 2, 1, 3, false);
    let rows =
        h.db.query("SELECT id,recorded_at FROM commits ORDER BY rowid", &[])
            .unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [id(1), id(2), id(3)]);
    let times: Vec<i64> = rows
        .iter()
        .map(|r| r["recorded_at"].as_i64().unwrap())
        .collect();
    assert!(times.is_sorted(), "{times:?}");
    let top =
        h.db.query("SELECT MAX(rowid) AS top FROM commit_paths", &[])
            .unwrap();
    assert_eq!(top[0]["top"], 6, "repo_storage estimates rows from it");
}

#[test]
fn parameters_stay_small_enough_for_a_durable_object() {
    let rows: Vec<Value> = (0..40_000).map(|n| json!([n, "x".repeat(64)])).collect();
    let chunks = super::super::history_fill::chunks(&rows);
    assert!(chunks.len() > 1);
    assert!(chunks.iter().all(|c| c.len() <= 1024 * 1024));
    let count: usize = chunks
        .iter()
        .map(|c| serde_json::from_str::<Vec<Value>>(c).unwrap().len())
        .sum();
    assert_eq!(count, 40_000);
}

#[test]
fn a_commit_parses_as_the_old_op_did() {
    let mut bad_path = commit(2, 2, false);
    bad_path["touches"][0]["path"] = json!("../up");
    assert!(Imported::parse(&bad_path).is_err());
    let mut no_generation = commit(2, 2, false);
    no_generation.as_object_mut().unwrap().remove("generation");
    assert!(Imported::parse(&no_generation).is_err());
}
