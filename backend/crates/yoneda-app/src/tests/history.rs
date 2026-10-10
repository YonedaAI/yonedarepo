use super::*;
use crate::storage::{
    edge, event, get, node, prune_outbox_payloads, run_detail, run_graph_page, run_page, save,
};
mod archive_command {
    use crate::SqlStore;
    use serde_json::{Value, json};
    pub fn handle<S: SqlStore>(db: &S, mut command: Value, now: i64) -> yoneda_core::Result<Value> {
        command["now"] = json!(now);
        crate::execute(db, command)
    }
}
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn run(id: &str, now: i64) -> Value {
    json!({"op":"start_run","id":id,"intent":"Inspect historical delivery","criteria":[],"now":now})
}

#[test]
fn lifetime_runs_are_not_capped_and_active_limit_is_transactional() {
    let db = repo();
    for n in 0..100 {
        let id = format!("history-{n:03}");
        call(&db, run(&id, 1000 + n)).unwrap();
        call(&db, json!({"op":"cancel_run","run_id":id,"now":1001+n})).unwrap();
    }
    assert_eq!(
        call(&db, run("history-100", 1200)).unwrap()["id"],
        "history-100"
    );
    call(
        &db,
        json!({"op":"cancel_run","run_id":"history-100","now":1201}),
    )
    .unwrap();
    for n in 0..6 {
        call(&db, run(&format!("active-{n}"), 2000 + n)).unwrap();
    }
    assert_eq!(
        call(&db, run("active-overflow", 2010)).unwrap_err().code,
        "ACTIVE_RUN_LIMIT"
    );
    db.query(
        "UPDATE runs SET payload=json_set(payload,'$.status','ready') WHERE id='active-0'",
        &[],
    )
    .unwrap();
    assert_eq!(
        call(&db, run("active-while-work-remains", 2011))
            .unwrap_err()
            .code,
        "ACTIVE_RUN_LIMIT"
    );
    call(
        &db,
        json!({"op":"cancel_run","run_id":"active-0","now":2012}),
    )
    .unwrap();
    assert!(call(&db, run("active-after-review", 2011)).is_ok());
}

#[test]
fn eligible_candidate_does_not_release_cap_while_peer_job_is_queued() {
    let policy = json!({"version":"site-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}],"static_dir":"public"}});
    let db = repo_with_policy(policy);
    let agents = json!([{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"},{"provider":"zai","model":"glm-4.7-flash","strategy":"accessible"}]);
    for n in 0..5 {
        call(&db,json!({"op":"start_run","id":format!("cap-{n}"),"intent":"Fill active work capacity","criteria":[],"agents":agents})).unwrap();
    }
    call(&db,json!({"op":"start_run","id":"peer-review","intent":"Build a checked website","criteria":[],"agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"},{"provider":"zai","model":"glm-4.7-flash","strategy":"accessible"}]})).unwrap();
    super::single_agent::eligible(&db, "peer-review", 1, &"c".repeat(40));
    assert_eq!(get(&db, "runs", "peer-review").unwrap()["status"], "ready");
    assert_eq!(
        get(&db, "jobs", "job:peer-review:agent-2").unwrap()["status"],
        "queued"
    );
    assert_eq!(crate::storage::active_run_count(&db).unwrap(), 6);
    assert_eq!(
        call(&db,json!({"op":"start_run","id":"cap-blocked","intent":"Check active limit","criteria":[],"agents":agents})).unwrap_err().code,
        "ACTIVE_RUN_LIMIT"
    );

    call(
        &db,
        json!({"op":"claim","job_id":"job:peer-review:agent-2"}),
    )
    .unwrap();
    call(&db,json!({"op":"fail","job_id":"job:peer-review:agent-2","epoch":1,"error":"fixture complete","retryable":false})).unwrap();
    assert_eq!(crate::storage::active_run_count(&db).unwrap(), 5);
    assert!(call(&db,json!({"op":"start_run","id":"cap-released","intent":"Check released active limit","criteria":[],"agents":agents})).is_ok());
}

#[test]
fn external_active_count_uses_live_execution_even_when_run_is_ready() {
    let db = repo();
    db.query(
        "INSERT INTO runs(id,payload) VALUES('run:external-ready',?)",
        &[json!(
            json!({"id":"run:external-ready","status":"ready","external":true}).to_string()
        )],
    )
    .unwrap();
    db.query("INSERT INTO executions(id,payload) VALUES('external-ready',?)", &[json!(json!({"id":"external-ready","run_id":"run:external-ready","harness":"external","status":"running"}).to_string())]).unwrap();
    assert_eq!(crate::storage::active_run_count(&db).unwrap(), 1);
    assert_eq!(crate::storage::external_run_count(&db).unwrap(), 1);
    db.query("UPDATE executions SET payload=json_set(payload,'$.status','completed') WHERE id='external-ready'", &[]).unwrap();
    assert_eq!(crate::storage::active_run_count(&db).unwrap(), 0);
    assert_eq!(crate::storage::external_run_count(&db).unwrap(), 0);
    db.query("UPDATE runs SET payload=json_set(payload,'$.status','exploring') WHERE id='run:external-ready'", &[]).unwrap();
    db.query("UPDATE executions SET payload=json_set(payload,'$.status','failed') WHERE id='external-ready'", &[]).unwrap();
    db.query("INSERT INTO jobs(id,payload) VALUES('job:external-ready',?)", &[json!(json!({"id":"job:external-ready","kind":"agent","external":true,"status":"failed","payload":{"execution":{"run_id":"run:external-ready"}}}).to_string())]).unwrap();
    assert_eq!(crate::storage::active_run_count(&db).unwrap(), 0);
    assert_eq!(crate::storage::external_run_count(&db).unwrap(), 0);
}

#[test]
fn history_pages_have_no_holes_and_hold_their_sequence_watermark() {
    let db = repo();
    assert!(run_page(&db, None, 50, Some(-1)).is_err());
    assert!(run_page(&db, None, 50, Some(9_007_199_254_740_992)).is_err());
    for n in 0..2107 {
        let id = format!("paged-{n:04}");
        let payload = json!({"id":id,"created_at":n,"status":"accepted"}).to_string();
        db.query(
            "INSERT INTO runs(id,payload) VALUES(?,?)",
            &[json!(id), json!(payload)],
        )
        .unwrap();
        let event = db
            .query(
                "INSERT INTO events(kind,at,data) VALUES('test.history',?, '{}') RETURNING seq",
                &[json!(n)],
            )
            .unwrap();
        db.query(
            "INSERT INTO run_history(run_id,seq,created_at) VALUES(?,?,?)",
            &[json!(id), event[0]["seq"].clone(), json!(n)],
        )
        .unwrap();
    }
    let first = run_page(&db, None, 50, None).unwrap();
    let watermark = first["watermark"].as_i64().unwrap();
    let mut cursor = first["next_cursor"].as_str().map(str::to_owned);
    let mut ids = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let late = json!({"id":"late","created_at":99999,"status":"accepted"}).to_string();
    db.query(
        "INSERT INTO runs(id,payload) VALUES('late',?)",
        &[json!(late)],
    )
    .unwrap();
    let event = db
        .query(
            "INSERT INTO events(kind,at,data) VALUES('test.history',99999, '{}') RETURNING seq",
            &[],
        )
        .unwrap();
    db.query(
        "INSERT INTO run_history(run_id,seq,created_at) VALUES('late',?,99999)",
        &[event[0]["seq"].clone()],
    )
    .unwrap();
    while let Some(next) = cursor {
        let page = run_page(&db, Some(&next), 50, Some(watermark)).unwrap();
        ids.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["id"].as_str().unwrap().to_owned()),
        );
        cursor = page["next_cursor"].as_str().map(str::to_owned);
    }
    assert_eq!(ids.len(), 2107);
    assert_eq!(
        ids.iter().collect::<std::collections::BTreeSet<_>>().len(),
        2107
    );
    assert!(!ids.iter().any(|id| id == "late"));
    assert_eq!(ids.first().unwrap(), "paged-2106");
}

#[test]
fn archive_commit_replay_and_corruption_keep_audited_receipt() {
    let db = repo();
    let mut run_payload = start(&db);
    let id = run_payload["id"].as_str().unwrap().to_owned();
    run_payload["status"] = json!("accepted");
    run_payload["created_at"] = json!(1);
    db.query(
        "UPDATE runs SET payload=? WHERE id=?",
        &[json!(run_payload.to_string()), json!(id)],
    )
    .unwrap();
    db.query("UPDATE jobs SET payload=json_set(payload,'$.status','cancelled') WHERE json_extract(payload,'$.payload.execution.run_id')=?", &[json!(id)]).unwrap();
    let prepared = archive_command::handle(
        &db,
        json!({"op":"archive_prepare","run_id":id}),
        40 * 24 * 60 * 60 * 1000,
    )
    .unwrap();
    let job = &prepared["job"];
    let digest = job["digest"].as_str().unwrap();
    let bundle_json = prepared["bundle_json"].as_str().unwrap();
    assert_eq!(yoneda_core::digest(bundle_json.as_bytes()), digest);
    let bundle: Value = serde_json::from_str(bundle_json).unwrap();
    for mutable in ["repository", "archive", "capabilities", "seq", "watermark"] {
        assert!(
            bundle.get(mutable).is_none(),
            "mutable archive field: {mutable}"
        );
    }
    let mut repository = get(&db, "repository", "repo").unwrap();
    repository["head_commit"] = json!("f".repeat(40));
    repository["version"] = json!(7);
    repository["policy"]["version"] = json!("new-policy");
    save(&db, "repository", "repo", &repository).unwrap();
    let mut current_run = get(&db, "runs", &id).unwrap();
    current_run["status"] = json!("ready");
    save(&db, "runs", &id, &current_run).unwrap();
    call(&db, run("unrelated-after-prepare", 50)).unwrap();
    let replay = archive_command::handle(
        &db,
        json!({"op":"archive_prepare","run_id":id}),
        40 * 24 * 60 * 60 * 1000,
    )
    .unwrap();
    assert_eq!(replay["bundle_json"], bundle_json);
    assert_eq!(
        serde_json::from_str::<Value>(bundle_json).unwrap()["run"]["status"],
        "accepted"
    );
    assert_eq!(archive_command::handle(&db,json!({"op":"archive_commit","job_id":job["id"],"digest":"0".repeat(64),"receipt_id":"bad"}),40*24*60*60*1000).unwrap_err().code,"ARCHIVE_DIGEST_MISMATCH");
    let commit = json!({"op":"archive_commit","job_id":job["id"],"digest":digest,"verified_digest":digest,"receipt_id":"receipt-1"});
    let receipt = archive_command::handle(&db, commit.clone(), 40 * 24 * 60 * 60 * 1000).unwrap();
    assert_eq!(
        archive_command::handle(&db, commit, 40 * 24 * 60 * 60 * 1000).unwrap(),
        receipt
    );
    assert_eq!(
        archive_command::handle(
            &db,
            json!({"op":"archive_status","run_id":id}),
            40 * 24 * 60 * 60 * 1000
        )
        .unwrap()["receipt"],
        receipt
    );
}

#[test]
fn delivered_outbox_payloads_prune_after_seven_days_but_keep_replay_guards() {
    let db = repo();
    event(
        &db,
        "history.test",
        100,
        json!({"fact":"retained in event ledger"}),
    )
    .unwrap();
    let jobs = db.query("SELECT id FROM outbox ORDER BY id", &[]).unwrap();
    for job in &jobs {
        db.query(
            "UPDATE outbox SET delivered=1 WHERE id=?",
            &[job["id"].clone()],
        )
        .unwrap();
    }
    let result = prune_outbox_payloads(&db, 8 * 24 * 60 * 60 * 1000 + 10000).unwrap();
    assert!(result["pruned_payloads"].as_u64().unwrap() > 0);
    let retained = db
        .query(
            "SELECT id,payload,payload_pruned FROM outbox ORDER BY id",
            &[],
        )
        .unwrap();
    assert_eq!(retained.len(), jobs.len());
    assert!(
        retained
            .iter()
            .all(|r| r["payload"] == "{}" && r["payload_pruned"] == 1)
    );
    assert_eq!(
        prune_outbox_payloads(&db, 9 * 24 * 60 * 60 * 1000).unwrap()["pruned_payloads"],
        0
    );
}

#[test]
fn run_detail_and_graph_pages_are_scoped_and_stable() {
    let db = repo();
    call(&db, run("detail-run", 100)).unwrap();
    let detail = run_detail(&db, "detail-run").unwrap();
    assert_eq!(detail["runs"], json!([detail["run"].clone()]));
    assert!(
        detail["executions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["run_id"] == "detail-run")
    );
    assert_eq!(detail["nodes"], json!([]));
    let first = run_graph_page(&db, "detail-run", None, 1, None).unwrap();
    assert_eq!(first["edges"].as_array().unwrap().len(), 1);
    let high = first["watermark"].as_i64().unwrap();
    edge(&db, "later-node", "detail-run", "late", "late edge").unwrap();
    event(&db, "test.late-edge", 200, json!({})).unwrap();
    let cursor = first["next_cursor"].as_str().unwrap();
    let next = run_graph_page(&db, "detail-run", Some(cursor), 20, Some(high)).unwrap();
    assert!(
        next["edges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["source"] != "later-node")
    );
}

#[test]
fn run_detail_and_graph_scope_actual_evaluation_and_producer_execution_artifact_shapes() {
    let db = repo();
    let created = start(&db);
    let run_id = created["id"].as_str().unwrap();
    let execution_id = "run-one:research";
    db.query("INSERT INTO candidates(id,payload) VALUES('candidate-actual',?)", &[json!(json!({"id":"candidate-actual","run_id":run_id,"execution":execution_id,"status":"evaluated"}).to_string())]).unwrap();
    let evaluation = yoneda_core::Evaluation {
        id: "evaluation-actual".into(),
        candidate: "candidate-actual".into(),
        revision: yoneda_core::Revision {
            repository: "example/project".into(),
            commit: "a".repeat(40),
        },
        policy: "policy-v1".into(),
        suite: "suite-v1".into(),
        environment: "environment-v1".into(),
        checks: vec![],
        evidence: "b".repeat(64),
    };
    let evaluation = serde_json::to_value(evaluation).unwrap();
    db.query(
        "INSERT INTO evaluations(id,payload) VALUES(?,?)",
        &[json!(evaluation["id"]), json!(evaluation.to_string())],
    )
    .unwrap();
    node(
        &db,
        "evaluation-actual",
        "evaluation",
        "Evaluation",
        "platform",
        10,
        evaluation,
    )
    .unwrap();
    let claim = call(&db, json!({"op":"claim","job_id":"job:run-one:research"})).unwrap();
    let actual_artifact = call(&db, json!({"op":"publish_artifact","job_id":claim["id"],"epoch":claim["epoch"],"id":"artifact-actual","digest":"c".repeat(64),"label":"Research note","kind":"research","metadata":{"assumptions":[{"statement":"Upstream p99 stays bounded","metric":"upstream_p99_ms","limit":100,"path":"src/main.rs"}]}})).unwrap();
    assert_eq!(actual_artifact["producer"], execution_id);
    let nested = json!({"id":"artifact-nested","producer":{"execution":execution_id},"kind":"research","label":"Legacy producer shape","digest":"d".repeat(64)});
    db.query(
        "INSERT INTO artifacts(id,payload) VALUES('artifact-nested',?)",
        &[json!(nested.to_string())],
    )
    .unwrap();
    node(
        &db,
        "artifact-nested",
        "context",
        "Legacy producer shape",
        "agent_assertion",
        11,
        nested,
    )
    .unwrap();
    edge(
        &db,
        "evaluation-actual",
        run_id,
        "checks",
        "evaluation provenance",
    )
    .unwrap();
    edge(
        &db,
        "artifact-nested",
        run_id,
        "produced_by",
        "nested execution provenance",
    )
    .unwrap();
    event(&db, "history.provenance-test", 12, json!({})).unwrap();

    let detail = run_detail(&db, run_id).unwrap();
    assert_eq!(
        detail["evaluations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["evaluation-actual"]
    );
    let artifact_ids = detail["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        artifact_ids,
        ["artifact-actual", "artifact-nested"].into_iter().collect()
    );
    let graph = run_graph_page(&db, run_id, None, 50, None).unwrap();
    let sources = graph["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["source"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(sources.contains("evaluation-actual"));
    assert!(sources.contains("artifact-nested"));
}

#[test]
fn external_contribution_started_event_populates_run_history_without_run_created() {
    let db = repo();
    let contribution = call(&db, json!({"op":"external_begin","id":"external-history","_grant":"history-grant","fork":"test/history","intent":"Check external history","criteria":[]})).unwrap();
    let run_id = contribution["payload"]["execution"]["run_id"]
        .as_str()
        .unwrap();
    let event = db.query("SELECT seq FROM events WHERE kind='contribution.started' AND json_extract(data,'$.execution')='external-history'", &[]).unwrap();
    assert_eq!(event.len(), 1);
    let history = db
        .query(
            "SELECT run_id,seq FROM run_history WHERE run_id=?",
            &[json!(run_id)],
        )
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["seq"], event[0]["seq"]);
    assert_eq!(
        run_page(&db, None, 50, None).unwrap()["items"][0]["id"],
        run_id
    );
}

#[test]
fn hot_lineage_reads_use_run_scoped_job_indexes() {
    let db = repo();
    let plan = db.query("EXPLAIN QUERY PLAN SELECT payload FROM jobs WHERE id IN (SELECT id FROM jobs WHERE json_extract(payload,'$.payload.execution.run_id')='run-one' UNION SELECT id FROM jobs WHERE json_extract(payload,'$.payload.run_id')='run-one' UNION SELECT id FROM jobs WHERE json_extract(payload,'$.payload.candidate.run_id')='run-one' UNION SELECT id FROM jobs WHERE json_extract(payload,'$.payload.decision_id') IN (SELECT id FROM decisions WHERE json_extract(payload,'$.run_id')='run-one')) ORDER BY id", &[]).unwrap();
    let plan = json!(plan).to_string();
    assert!(plan.contains("jobs_by_execution_run"), "{plan}");
    assert!(plan.contains("jobs_by_run"), "{plan}");
    assert!(plan.contains("jobs_by_candidate_run"), "{plan}");
    assert!(plan.contains("jobs_by_decision"), "{plan}");
    let plan = db.query("EXPLAIN QUERY PLAN SELECT e.payload FROM candidates c CROSS JOIN evaluations e INDEXED BY evaluations_by_candidate WHERE json_extract(c.payload,'$.run_id')='run-one' AND json_extract(e.payload,'$.candidate')=c.id", &[]).unwrap();
    let plan = json!(plan).to_string();
    assert!(plan.contains("candidates_by_run"), "{plan}");
    assert!(plan.contains("evaluations_by_candidate"), "{plan}");
    for (path, index) in [
        ("$.run_id", "artifacts_by_run"),
        ("$.producer", "artifacts_by_producer"),
        ("$.producer.execution", "artifacts_by_producer_execution"),
        (
            "$.producer.execution.id",
            "artifacts_by_producer_execution_id",
        ),
    ] {
        let sql = format!(
            "EXPLAIN QUERY PLAN SELECT id FROM artifacts WHERE json_extract(payload,'{path}') IN ('run-one:research')"
        );
        let plan = json!(db.query(&sql, &[]).unwrap()).to_string();
        assert!(plan.contains(index), "{plan}");
    }
}

#[test]
fn migration_eleven_upgrades_a_real_v8_schema_and_repeats_cleanly() {
    let db = NativeStore::memory().unwrap();
    db.query(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    let migrations = [
        include_str!("../migrations/0001_ledger.sql"),
        include_str!("../migrations/0002_run_index.sql"),
        include_str!("../migrations/0003_execution_graph.sql"),
        include_str!("../migrations/0004_state_graph.sql"),
        include_str!("../migrations/0005_model_reservations.sql"),
        include_str!("../migrations/0006_execution_logs.sql"),
        include_str!("../migrations/0007_context_access.sql"),
        include_str!("../migrations/0008_team_runs.sql"),
    ];
    for (index, sql) in migrations.iter().enumerate() {
        for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
            db.query(statement, &[]).unwrap();
        }
        db.query(
            "INSERT INTO schema_migrations(version,digest) VALUES(?,?)",
            &[json!(index + 1), json!(yoneda_core::digest(sql.as_bytes()))],
        )
        .unwrap();
    }
    migrate(&db).unwrap();
    migrate(&db).unwrap();
    assert_eq!(
        db.query("SELECT MAX(version) AS version FROM schema_migrations", &[])
            .unwrap()[0]["version"],
        12
    );
    assert_eq!(db.query("SELECT COUNT(*) AS count FROM pragma_table_info('outbox') WHERE name IN ('created_at','payload_pruned')",&[]).unwrap()[0]["count"],2);
    assert_eq!(db.query("SELECT COUNT(*) AS count FROM pragma_table_info('execution_logs') WHERE name='data_pruned'", &[]).unwrap()[0]["count"], 1);
    assert_eq!(db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name IN ('evaluations_by_candidate','artifacts_by_producer','artifacts_by_producer_execution','artifacts_by_producer_execution_id')", &[]).unwrap()[0]["count"], 4);
}

#[test]
fn archive_interruption_replay_compacts_only_after_verified_ack_and_retains_references() {
    let db = repo();
    let mut run = start(&db);
    let id = run["id"].as_str().unwrap().to_owned();
    run["status"] = json!("accepted");
    run["created_at"] = json!(1);
    db.query(
        "UPDATE runs SET payload=? WHERE id=?",
        &[json!(run.to_string()), json!(id)],
    )
    .unwrap();
    db.query("UPDATE executions SET payload=json_set(payload,'$.status','done') WHERE json_extract(payload,'$.run_id')=?", &[json!(id)]).unwrap();
    db.query("UPDATE jobs SET payload=json_set(payload,'$.status','done','$.payload.execution.context','bulk context','$.payload.policy','bulk policy') WHERE json_extract(payload,'$.payload.execution.run_id')=?", &[json!(id)]).unwrap();
    db.query(
        "INSERT INTO candidates(id,payload) VALUES('candidate-archive',?)",
        &[json!(
            json!({"id":"candidate-archive","run_id":id,"diff_digest":"a".repeat(64)}).to_string()
        )],
    )
    .unwrap();
    db.query("INSERT INTO evaluations(id,payload) VALUES('eval-archive',?)", &[json!(json!({"id":"eval-archive","run_id":id,"candidate_id":"candidate-archive","result":"pass"}).to_string())]).unwrap();
    db.query(
        "INSERT INTO decisions(id,payload) VALUES('decision-archive',?)",
        &[json!(
            json!({"id":"decision-archive","run_id":id,"candidate_id":"candidate-archive"})
                .to_string()
        )],
    )
    .unwrap();
    db.query("INSERT INTO execution_logs(event_id,execution_id,at,data) VALUES('archive-log','run-one:research',9,'{\"stage\":\"execution.started\"}')", &[]).unwrap();
    let prepare = json!({"op":"archive_prepare","run_id":id});
    let first = archive_command::handle(&db, prepare.clone(), 40 * 24 * 60 * 60 * 1000).unwrap();
    let retried = archive_command::handle(&db, prepare, 40 * 24 * 60 * 60 * 1000).unwrap();
    assert_eq!(first["job"]["digest"], retried["job"]["digest"]);
    db.query("INSERT INTO execution_logs(event_id,execution_id,at,data) VALUES('after-prepare-log','run-one:research',10,'{\"stage\":\"execution.finished\"}')", &[]).unwrap();
    let bundle: Value = serde_json::from_str(first["bundle_json"].as_str().unwrap()).unwrap();
    assert!(
        bundle["execution_logs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|log| log["event_id"] == "archive-log")
    );
    let job = &first["job"];
    assert_eq!(job["object_key"], format!("history/repo-test/{id}.json"));
    let mut commit = json!({"op":"archive_commit","job_id":job["id"],"digest":job["digest"],"receipt_id":"receipt-archive"});
    assert_eq!(
        archive_command::handle(&db, commit.clone(), 40 * DAY_MS)
            .unwrap_err()
            .code,
        "ARCHIVE_DIGEST_MISMATCH"
    );
    commit["verified_digest"] = job["digest"].clone();
    let receipt = archive_command::handle(&db, commit.clone(), 40 * DAY_MS).unwrap();
    assert_eq!(
        archive_command::handle(&db, commit, 41 * DAY_MS).unwrap(),
        receipt
    );
    let compacted: Value = serde_json::from_str(
        db.query(
            "SELECT payload FROM jobs WHERE json_extract(payload,'$.payload.execution.run_id')=?",
            &[json!(id)],
        )
        .unwrap()[0]["payload"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(compacted["payload"]["execution"]["id"], "run-one:research");
    assert!(compacted["payload"]["execution"].get("context").is_none());
    assert!(compacted["payload"].get("policy").is_none());
    let log = db
        .query(
            "SELECT event_id,data,data_pruned FROM execution_logs WHERE event_id='archive-log'",
            &[],
        )
        .unwrap();
    assert_eq!(log[0]["data_pruned"], 1);
    assert_eq!(log[0]["data"], "{}");
    let post_prepare_log = db
        .query(
            "SELECT data,data_pruned FROM execution_logs WHERE event_id='after-prepare-log'",
            &[],
        )
        .unwrap();
    assert_eq!(post_prepare_log[0]["data_pruned"], 0);
    assert_eq!(
        post_prepare_log[0]["data"],
        "{\"stage\":\"execution.finished\"}"
    );
    assert_eq!(
        get(&db, "candidates", "candidate-archive").unwrap()["diff_digest"],
        "a".repeat(64)
    );
    assert_eq!(
        get(&db, "evaluations", "eval-archive").unwrap()["result"],
        "pass"
    );
    assert_eq!(
        get(&db, "decisions", "decision-archive").unwrap()["candidate_id"],
        "candidate-archive"
    );
    assert_eq!(
        run_detail(&db, &id).unwrap()["archive"]["digest"],
        job["digest"]
    );
}

#[test]
fn archive_blocks_running_internal_and_external_attempts_and_daily_schedule_is_idempotent() {
    let db = repo();
    let mut run = start(&db);
    let id = run["id"].as_str().unwrap().to_owned();
    run["status"] = json!("accepted");
    run["created_at"] = json!(1);
    db.query(
        "UPDATE runs SET payload=? WHERE id=?",
        &[json!(run.to_string()), json!(id)],
    )
    .unwrap();
    let job_id = format!("job:{id}:research");
    db.query(
        "UPDATE jobs SET payload=json_set(payload,'$.status','running','$.external',1) WHERE id=?",
        &[json!(job_id)],
    )
    .unwrap();
    assert_eq!(
        archive_command::handle(
            &db,
            json!({"op":"archive_prepare","run_id":id}),
            40 * DAY_MS
        )
        .unwrap_err()
        .code,
        "ARCHIVE_ACTIVE_WORK"
    );
    db.query(
        "UPDATE jobs SET payload=json_set(payload,'$.status','done','$.external',0) WHERE id=?",
        &[json!(job_id)],
    )
    .unwrap();
    let first =
        archive_command::handle(&db, json!({"op":"schedule_archive_due"}), 40 * DAY_MS).unwrap();
    let again = archive_command::handle(
        &db,
        json!({"op":"schedule_archive_due"}),
        40 * DAY_MS + 1000,
    )
    .unwrap();
    assert_eq!(first["scheduled"], true);
    assert_eq!(again["scheduled"], false);
    assert_eq!(
        db.query(
            "SELECT COUNT(*) AS count FROM outbox WHERE kind='archive_due'",
            &[]
        )
        .unwrap()[0]["count"],
        1
    );
    assert_eq!(
        db.query(
            "SELECT COUNT(*) AS count FROM events WHERE kind='history.archive_due_scheduled'",
            &[]
        )
        .unwrap()[0]["count"],
        1
    );
}
