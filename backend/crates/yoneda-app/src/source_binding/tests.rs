use super::*;
use crate::native::NativeStore;
fn db() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    crate::migrate(&db).unwrap();
    let policy = json!({"build":{"test_bundle":{"protected_paths":["schema.json"]}}});
    save(&db,"repository","repo",&json!({"id":"repo","policy":policy,"status":"ready","version":0,"head_commit":"a".repeat(40),"pending":null})).unwrap();
    let base = json!({"repository":"test/base","commit":"a".repeat(40)});
    save(&db,"runs","run",&json!({"id":"run","intent":"Fix safely","policy":policy,"workspace_transport":TRANSPORT,"base":base,"source_base":{"repository":"test/base","commit":"a".repeat(40),"tree":"b".repeat(40)},"base_version":0,"status":"exploring","team_plan_revision":null})).unwrap();
    let e = json!({"id":"execution","run_id":"run","role":"coding","base":base});
    save(&db, "executions", "execution", &e).unwrap();
    save(&db,"jobs","job",&json!({"id":"job","kind":"agent","status":"running","epoch":1,"lease_until":50000,"attempt_deadline":90000,"payload":{"execution":e,"policy":policy,"workspace_transport":TRANSPORT}})).unwrap();
    db
}
fn view() -> SourceView {
    SourceView {
        version: 1,
        base: SourceRevision {
            repository: "test/base".into(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
        },
        files: vec![],
    }
}
const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn call(db: &NativeStore, mut c: Value) -> Result<Value> {
    c["now"] = json!(1000);
    c["_source_signing_key"] = json!(KEY);
    let owned = db.clone();
    db.transaction(Box::new(move || handle(&owned, &c, 1000)))
}
fn bind(db: &NativeStore) -> Value {
    call(db,json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view":view(),"_supervisor":true})).unwrap()
}
#[test]
fn source_binding_refresh_readonly_tightening_and_queued_context_never_grants_actor() {
    let db = db();
    let b = bind(&db);
    let before = get(&db, "jobs", "job").unwrap();
    assert_eq!(bind(&db), b);
    assert_eq!(get(&db, "jobs", "job").unwrap(), before);
    let tightened=call(&db,json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view":view(),"_read_only":true})).unwrap();
    assert_eq!(tightened["binding"], b["binding"]);
    assert_eq!(tightened["actor_grant"]["claims"]["access"], "read_only");
    let mut job = before;
    job["status"] = json!("queued");
    save(&db, "jobs", "job", &job).unwrap();
    let context = call(&db, json!({"op":"source_read_context","job_id":"job"})).unwrap();
    assert!(context.get("actor_grant").is_none());
    assert_eq!(
        call(
            &db,
            json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view":view()})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
}
#[test]
fn source_registration_rejects_caller_fabricated_seal_and_accepts_actual_signed_receipt() {
    let db = db();
    let b = bind(&db);
    let source = NativeStore::memory().unwrap();
    let actor = b["actor_grant"].clone();
    let call_source = |mut c: Value| {
        c["now"] = json!(1000);
        c["_source_signing_key"] = json!(KEY);
        c["_actor"] = actor.clone();
        source_workspace::execute_source_workspace(&source, c)
    };
    call_source(json!({"op":"source_init","request_id":"init","binding":b["binding"],"view":view(),"baseline_overrides":[]})).unwrap();
    let checkpoint = call_source(
        json!({"op":"source_checkpoint","request_id":"checkpoint","expected_workspace_version":0}),
    )
    .unwrap();
    let receipt=call_source(json!({"op":"source_seal","request_id":"seal","expected_workspace_version":0,"checkpoint_id":checkpoint["checkpoint_id"],"expected_checkpoint_digest":checkpoint["changeset_digest"]})).unwrap();
    let mut forged = receipt.clone();
    forged["attestation"]["signature"] = json!("0".repeat(64));
    let input = json!({"op":"source_register_changeset","request_id":"register","job_id":"job","epoch":1,"view_digest":b["binding"]["view_digest"],"_source_seal":forged});
    assert_eq!(call(&db, input.clone()).unwrap_err().code, "FORBIDDEN");
    assert!(get(&db, "jobs", "job").unwrap()["source_registered"].is_null());
    let mut oversized = input.clone();
    oversized["_source_seal"] = receipt.clone();
    oversized["_source_seal"]["changeset_header"]["changes"] =
        json!([{"untrusted":"x".repeat(2*1024*1024)}]);
    assert_eq!(
        call(&db, oversized)
            .err()
            .map(|e| e.code)
            .unwrap_or_default(),
        "INVALID_INPUT"
    );
    let mut valid = input;
    valid["_source_seal"] = receipt;
    let registered = call(&db, valid.clone()).unwrap();
    assert_eq!(call(&db, valid).unwrap(), registered);
    assert!(registered.get("changeset").is_none());
    assert_eq!(registered["authority"], "staged_source");
}
#[test]
fn source_digest_refresh_is_compact_and_current_policy_epoch_fenced() {
    let db = db();
    let first = bind(&db);
    let old = get(&db, "jobs", "job").unwrap();
    let request = json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view_digest":first["binding"]["view_digest"],"_supervisor":true});
    let refreshed = call(&db, request.clone()).unwrap();
    assert_eq!(refreshed["binding"], first["binding"]);
    assert!(refreshed.get("baseline_overrides").is_none());
    assert_eq!(get(&db, "jobs", "job").unwrap(), old);
    let mut stale = request.clone();
    stale["epoch"] = json!(2);
    assert_eq!(call(&db, stale).unwrap_err().code, "FENCED");
    let mut repository = repo(&db).unwrap();
    repository["policy"]["changed"] = json!(true);
    save(&db, "repository", "repo", &repository).unwrap();
    assert_eq!(call(&db, request).unwrap_err().code, "POLICY_CHANGED");
}
#[test]
fn evaluation_source_is_exact_candidate_readonly_not_agent_or_original_base() {
    let db = db();
    let mut candidate = json!({"id":"candidate","run_id":"run","execution":"execution","paths":[],"revision":{"repository":"test/captured","commit":"f".repeat(40)},"tree":"c".repeat(40),"status":"evaluating"});
    crate::path_lists::compact(&db, &mut candidate, "paths").unwrap();
    save(&db, "candidates", "candidate", &candidate).unwrap();
    let mut job = get(&db, "jobs", "job").unwrap();
    job["kind"] = json!("evaluate");
    job["payload"]["source_integrity"] =
        crate::path_lists::integrity::fields(&db, &candidate, &job["payload"]["policy"]).unwrap();
    job["payload"]["candidate"] = candidate;
    job["payload"].as_object_mut().unwrap().remove("execution");
    save(&db, "jobs", "job", &job).unwrap();
    let context = call(
        &db,
        json!({"op":"source_read_context","job_id":"job","epoch":1}),
    )
    .unwrap();
    assert_eq!(context["role"], "evaluator");
    assert_eq!(context["base"]["repository"], "test/captured");
    assert_eq!(context["access"], "read_only");
    let evaluation_view = SourceView {
        version: 1,
        base: decode(&context["base"]).unwrap(),
        files: vec![],
    };
    let bound = call(
        &db,
        json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view":evaluation_view}),
    )
    .unwrap();
    assert_eq!(bound["binding"]["write_paths"], json!([]));
    assert_eq!(bound["actor_grant"]["claims"]["access"], "read_only");
}
#[test]
fn current_capture_lease_reads_sealed_manifest_without_reviving_producer() {
    let db = db();
    let bound = bind(&db);
    let source = NativeStore::memory().unwrap();
    let actor = bound["actor_grant"].clone();
    let call_source = |mut c: Value| {
        c["now"] = json!(1000);
        c["_source_signing_key"] = json!(KEY);
        c["_actor"] = actor.clone();
        source_workspace::execute_source_workspace(&source, c)
    };
    call_source(json!({"op":"source_init","request_id":"init","binding":bound["binding"],"view":view(),"baseline_overrides":[]})).unwrap();
    let checkpoint = call_source(
        json!({"op":"source_checkpoint","request_id":"checkpoint","expected_workspace_version":0}),
    )
    .unwrap();
    let seal=call_source(json!({"op":"source_seal","request_id":"seal","expected_workspace_version":0,"checkpoint_id":checkpoint["checkpoint_id"],"expected_checkpoint_digest":checkpoint["changeset_digest"]})).unwrap();
    let registration=call(&db,json!({"op":"source_register_changeset","request_id":"register","job_id":"job","epoch":1,"view_digest":bound["binding"]["view_digest"],"_source_seal":seal})).unwrap();
    let mut producer = get(&db, "jobs", "job").unwrap();
    producer["status"] = json!("completed");
    producer["lease_until"] = json!(500);
    save(&db, "jobs", "job", &producer).unwrap();
    let capture = json!({"id":"capture","kind":"capture","status":"running","epoch":2,"lease_until":50000,"attempt_deadline":90000,"payload":{"capture_subtype":"source_changeset","policy":repo(&db).unwrap()["policy"],"source_registered":{"producer_job_id":"job","producer_epoch":1,"registration_id":registration["registration_id"],"changeset_digest":registration["changeset_digest"]}}});
    save(&db, "jobs", "capture", &capture).unwrap();
    let context = call(
        &db,
        json!({"op":"source_capture_context","job_id":"capture","epoch":2}),
    )
    .unwrap();
    assert_eq!(context["seal"]["seal_id"], registration["seal_id"]);
    assert!(context.to_string().len() < 10000);
    assert_eq!(
        call(
            &db,
            json!({"op":"source_capture_context","job_id":"capture","epoch":1})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
    assert_eq!(call(&db,json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view_digest":bound["binding"]["view_digest"]})).unwrap_err().code,"FENCED");
    let page=source_workspace::execute_source_workspace(&source,json!({"op":"source_manifest","now":1000,"_source_signing_key":KEY,"_capture_grant":context["_capture_grant"],"checkpoint_id":registration["checkpoint_id"],"section":"changes"})).unwrap();
    assert_eq!(page["items"], json!([]));
}
#[test]
fn specialist_source_scope_is_current_task_ownership_not_legacy_capture_union() {
    let db = db();
    let mut execution = get(&db, "executions", "execution").unwrap();
    execution["team_task"] = json!("task");
    execution["team_task_revision"] = json!(1);
    execution["team_role"] = json!("worker");
    save(&db, "executions", "execution", &execution).unwrap();
    save(
        &db,
        "team_tasks",
        "task",
        &json!({"id":"task","run_id":"run","revision":1,"write_paths":["src/"]}),
    )
    .unwrap();
    let mut job = get(&db, "jobs", "job").unwrap();
    job["payload"]["execution"] = execution;
    job["payload"]["team_write_paths"] = json!(["src/", "docs/dependency.md"]);
    save(&db, "jobs", "job", &job).unwrap();
    let context = call(
        &db,
        json!({"op":"source_read_context","job_id":"job","epoch":1}),
    )
    .unwrap();
    assert_eq!(context["write_paths"], json!(["src/"]));
}
#[test]
fn scratch_binding_proves_absence_and_cannot_hide_tracked_source_or_stage_generated_cache() {
    let db = db();
    let bound = bind(&db);
    let scratch: SourceBinding = decode(&bound["binding"]).unwrap();
    assert!(
        scratch.authorize_path("node_modules/cache.js").is_err(),
        "API source mutation must not hide under local scratch"
    );
    let tracked = SourceFile {
        path: "node_modules/app.mjs".into(),
        mode: FileMode::Regular,
        size: 1,
        content: ContentRef::Git {
            repository: "test/base".into(),
            commit: "a".repeat(40),
            path: "node_modules/app.mjs".into(),
            blob: "c".repeat(40),
        },
    };
    let mut view = view();
    view.files = vec![tracked];
    let bound = call(
        &db,
        json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view":view}),
    )
    .unwrap();
    let tracked_binding: SourceBinding = decode(&bound["binding"]).unwrap();
    tracked_binding
        .authorize_path("node_modules/app.mjs")
        .unwrap();
}
#[test]
fn unrelated_plan_amendment_preserves_unchanged_specialist_but_changed_task_fences() {
    let db = db();
    let mut run = get(&db, "runs", "run").unwrap();
    run["team_plan_revision"] = json!(1);
    save(&db, "runs", "run", &run).unwrap();
    let mut execution = get(&db, "executions", "execution").unwrap();
    execution["team_task"] = json!("task");
    execution["team_task_revision"] = json!(1);
    execution["team_role"] = json!("worker");
    save(&db, "executions", "execution", &execution).unwrap();
    let task = json!({"id":"task","run_id":"run","revision":1,"write_paths":["src/"]});
    save(&db, "team_tasks", "task", &task).unwrap();
    let mut job = get(&db, "jobs", "job").unwrap();
    job["payload"]["execution"] = execution;
    save(&db, "jobs", "job", &job).unwrap();
    let bound = bind(&db);
    run["team_plan_revision"] = json!(2);
    save(&db, "runs", "run", &run).unwrap();
    let refresh = json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view_digest":bound["binding"]["view_digest"]});
    assert_eq!(
        call(&db, refresh.clone()).unwrap()["binding"],
        bound["binding"]
    );
    let mut changed = task;
    changed["revision"] = json!(2);
    save(&db, "team_tasks", "task", &changed).unwrap();
    assert_eq!(call(&db, refresh).unwrap_err().code, "FENCED");
}
#[test]
fn coordinator_own_repair_keeps_readonly_source_but_foreign_plan_change_fences() {
    let db = db();
    let mut run = get(&db, "runs", "run").unwrap();
    run["team_plan_revision"] = json!(1);
    save(&db, "runs", "run", &run).unwrap();
    let mut execution = get(&db, "executions", "execution").unwrap();
    execution["team_role"] = json!("coordinator");
    execution["team_plan_revision"] = json!(1);
    save(&db, "executions", "execution", &execution).unwrap();
    let mut job = get(&db, "jobs", "job").unwrap();
    job["payload"]["execution"] = execution;
    job["payload"]["team_planning"] = json!(true);
    save(&db, "jobs", "job", &job).unwrap();
    let bound = call(
        &db,
        json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view":view()}),
    )
    .unwrap();
    assert_eq!(bound["binding"]["access"], "read_only");
    assert_eq!(bound["binding"]["write_paths"], json!([]));
    // The coordinator's own repair_team call advances the plan while its agent keeps reading.
    run["team_plan_revision"] = json!(2);
    run["team_plan_amendments"] = json!([{"plan_revision":2,"supersedes_revision":1,"approved_by":"run_autonomy_policy","execution_id":"execution"}]);
    save(&db, "runs", "run", &run).unwrap();
    let refresh = json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view_digest":bound["binding"]["view_digest"]});
    let refreshed = call(&db, refresh.clone()).unwrap();
    assert_eq!(refreshed["binding"], bound["binding"]);
    assert_eq!(refreshed["actor_grant"]["claims"]["access"], "read_only");
    // Any plan revision this coordinator did not author still fences its source.
    run["team_plan_revision"] = json!(3);
    run["team_plan_amendments"]
        .as_array_mut()
        .unwrap()
        .push(json!({"plan_revision":3,"supersedes_revision":2,"approved_by":"repository_owner","execution_id":null}));
    save(&db, "runs", "run", &run).unwrap();
    assert_eq!(call(&db, refresh).unwrap_err().code, "FENCED");
}
#[test]
fn api_resolver_uses_current_target_and_premerged_clean_paths_not_original_run_tree() {
    let db = db();
    let mut r = repo(&db).unwrap();
    r["head_commit"] = json!("c".repeat(40));
    r["version"] = json!(1);
    save(&db, "repository", "repo", &r).unwrap();
    let target = json!({"repository":"test/base","commit":"c".repeat(40)});
    let workspace = json!({"repository":"test/merge","commit":"e".repeat(40)});
    let candidate = json!({"id":"candidate","run_id":"run","revision":{"repository":"test/candidate","commit":"f".repeat(40)},"tree":"d".repeat(40)});
    let record = json!({"id":"conflict","status":"resolving","resolver_job_id":"job","resolver_execution_id":"execution","head_commit":"c".repeat(40),"expected_version":1,"target_revision":target,"expected_head_tree":"d".repeat(40),"candidate":candidate,"candidate_revision":"f".repeat(40),"workspace_revision":workspace,"merge_workspace_commit":"e".repeat(40),"merge_tree":"b".repeat(40),"conflict_paths":["conflict.rs"],"merged_paths":["clean.rs","conflict.rs"]});
    save(&db, "conflicts", "conflict", &record).unwrap();
    let mut e = get(&db, "executions", "execution").unwrap();
    e["base"] = target;
    e["conflict_id"] = json!("conflict");
    e["conflict_paths"] = json!(["conflict.rs"]);
    save(&db, "executions", "execution", &e).unwrap();
    let mut job = get(&db, "jobs", "job").unwrap();
    job["payload"]["execution"] = e;
    job["payload"]["conflict_resolver"] = json!({"conflict_id":"conflict"});
    job["payload"]["team_owned_paths"] = json!(["conflict.rs"]);
    save(&db, "jobs", "job", &job).unwrap();
    let context = call(
        &db,
        json!({"op":"source_read_context","job_id":"job","epoch":1}),
    )
    .unwrap();
    assert_eq!(context["base"]["commit"], "c".repeat(40));
    assert_eq!(context["parents"], json!(["c".repeat(40), "f".repeat(40)]));
    assert_eq!(
        context["baseline_inputs"][0]["paths"],
        json!(["clean.rs", "conflict.rs"])
    );
    assert_eq!(context["baseline_inputs"][0]["revision"], workspace);
    assert_eq!(context["write_paths"], json!(["conflict.rs"]));
    let clean = SourceFile {
        path: "clean.rs".into(),
        size: 1,
        mode: FileMode::Regular,
        content: ContentRef::Git {
            repository: "test/merge".into(),
            commit: "e".repeat(40),
            path: "clean.rs".into(),
            blob: "a".repeat(40),
        },
    };
    let view = SourceView {
        version: 1,
        base: decode(&context["base"]).unwrap(),
        files: vec![],
    };
    let overrides = json!([{"path":"clean.rs","file":clean},{"path":"conflict.rs","file":null}]);
    let bound=call(&db,json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view":view,"_source_baseline_overrides":overrides})).unwrap();
    assert_eq!(bound["binding"]["parents"], context["parents"]);
    let secondary = SourceView {
        version: 1,
        base: decode(&context["inputs"][1]).unwrap(),
        files: vec![],
    };
    let readonly = call(
        &db,
        json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view":secondary}),
    )
    .unwrap();
    assert_eq!(readonly["binding"]["access"], "read_only");
    assert_eq!(
        readonly["binding"]["scratch_paths"],
        json!([]),
        "secondary exact input must never be shadowed by local scratch"
    );
    assert_eq!(context["source_resolution"], true);
    assert_eq!(context["role"], "repair");
    assert_eq!(context["source_mounts"][1]["path"], "candidate-0");
    assert_eq!(context["source_mounts"][2]["path"], "candidate-1");

    let mut r = repo(&db).unwrap();
    r["version"] = json!(2);
    save(&db, "repository", "repo", &r).unwrap();
    assert_eq!(call(&db,json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view_digest":bound["binding"]["view_digest"]})).unwrap_err().code,"HEAD_MOVED");
}
#[test]
fn failed_comparison_roots_expose_only_actual_captured_review_inputs() {
    for captured in [false, true] {
        let db = db();
        let mut run = get(&db, "runs", "run").unwrap();
        run["comparison"] = json!({"approval":{"id":"approval","policy":run["policy"]}});
        save(&db, "runs", "run", &run).unwrap();
        let mut e = get(&db, "executions", "execution").unwrap();
        e["comparison_role"] = json!("reviewer");
        e["comparison_approval_id"] = json!("approval");
        save(&db, "executions", "execution", &e).unwrap();
        let revision = json!({"repository":"test/captured","commit":"c".repeat(40)});
        if captured {
            save(&db,"candidates","captured",&json!({"id":"captured","run_id":"run","revision":revision,"tree":"d".repeat(40),"status":"rejected"})).unwrap();
        }
        let manifest = json!({"version":1,"alternatives":[{"agent_index":0,"candidate_id":null,"revision":null,"status":"failed"},{"agent_index":1,"candidate_id":if captured {json!("captured")}else{Value::Null},"revision":if captured {revision.clone()}else{Value::Null},"status":if captured{"rejected"}else{"failed"}}]});
        let mut job = get(&db, "jobs", "job").unwrap();
        job["payload"]["execution"] = e;
        job["payload"]["comparison_manifest"] = json!({"manifest":manifest,"manifest_digest":yoneda_core::fingerprint(&manifest).unwrap()});
        save(&db, "jobs", "job", &job).unwrap();
        let context = call(
            &db,
            json!({"op":"source_read_context","job_id":"job","epoch":1}),
        )
        .unwrap();
        assert_eq!(context["role"], "reviewer");
        assert_eq!(context["access"], "read_only");
        let candidates: Vec<_> = context["source_mounts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["path"] != "repo")
            .collect();
        assert_eq!(candidates.len(), usize::from(captured));
        assert_eq!(
            context["inputs"].as_array().unwrap().len(),
            1 + usize::from(captured)
        );
        if captured {
            assert_eq!(candidates[0]["path"], "candidate-0");
            assert_eq!(candidates[0]["base"]["repository"], revision["repository"]);
            assert_eq!(candidates[0]["base"]["commit"], revision["commit"]);
            let view = SourceView {
                version: 1,
                base: decode(&candidates[0]["base"]).unwrap(),
                files: vec![],
            };
            let bound = call(
                &db,
                json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view":view}),
            )
            .unwrap();
            assert_eq!(bound["binding"]["access"], "read_only");
            assert_eq!(bound["binding"]["scratch_paths"], json!([]));
            assert_eq!(bound["binding"]["write_paths"], json!([]));
        }
        let foreign = SourceView {
            version: 1,
            base: SourceRevision {
                repository: "test/not-captured".into(),
                commit: "e".repeat(40),
                tree: "f".repeat(40),
            },
            files: vec![],
        };
        assert_eq!(
            call(
                &db,
                json!({"op":"source_bind","job_id":"job","epoch":1,"_source_view":foreign})
            )
            .unwrap_err()
            .code,
            "FORBIDDEN"
        );
        job["payload"]["comparison_manifest"]["manifest"]["alternatives"][0]["candidate_id"] =
            json!("invented");
        save(&db, "jobs", "job", &job).unwrap();
        assert_eq!(
            call(
                &db,
                json!({"op":"source_read_context","job_id":"job","epoch":1})
            )
            .unwrap_err()
            .code,
            "FENCED"
        );
    }
}
