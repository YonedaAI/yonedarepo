//! Test kit: drive a leased job through the real API source seal, registration and capture
//! commands. The SOURCES store is a separate native authority, as in the Worker.
use crate::native::NativeStore;
use crate::source_workspace;
use serde_json::{Value, json};
use yoneda_agents_core::source_workspace::SourceView;

pub const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn call(db: &NativeStore, mut c: Value, now: i64) -> Value {
    c["now"] = json!(now);
    crate::execute(db, c).unwrap()
}

fn published(db: &NativeStore) -> Value {
    crate::storage::repo(db)
        .map(|r| {
            json!({"repository":format!("{}/{}",r["remote"]["namespace"].as_str().unwrap_or_default(),
                r["remote"]["name"].as_str().unwrap_or_default()),"commit":r["published_commit"]})
        })
        .unwrap_or(Value::Null)
}

fn working(db: &NativeStore, id: Option<&str>) -> Option<Value> {
    crate::storage::get(db, "working_branches", id?)
        .ok()
        .map(|b| b["working_revision"].clone())
}

fn approve(run: &mut Value, base: &Value) {
    if run.get("workspace_transport").is_some() {
        return;
    }
    run["workspace_transport"] = json!("api-source-v1");
    run["_source_transport_approved"] = json!(true);
    run["_source_base"] =
        json!({"repository":base["repository"],"commit":base["commit"],"tree":"b".repeat(40)});
}

/// What the Worker adds to every owner run approval after reading the platform: the API source
/// transport and its approved frozen base (the working branch head, else the published commit).
pub fn approve_start(db: &NativeStore, c: &mut Value) {
    if c["op"] == "start_run" {
        let base = working(db, c["working_branch_id"].as_str()).unwrap_or_else(|| published(db));
        approve(c, &base);
    } else if c["op"] == "start_guided_step" {
        let session = c["session_id"].as_str().unwrap_or_default();
        let branch = crate::storage::get(db, "nodes", session)
            .ok()
            .and_then(|n| n["data"]["working_branch_id"].as_str().map(str::to_owned));
        let mut base = working(db, branch.as_deref()).unwrap_or_else(|| published(db));
        // A concurrent retry restarts from the checked extend checkpoint, not the branch head.
        if c["retry"] == true && c["step_id"] == "concurrent" {
            let view = crate::execute(
                db,
                json!({"op":"guided_session","_workspace":c["_workspace"],"id":session,"now":c["now"]}),
            )
            .unwrap_or(Value::Null);
            if let Some(extend) = view["steps"].as_array().and_then(|steps| {
                steps
                    .iter()
                    .find(|step| step["id"] == "extend")
                    .map(|step| step["revision"].clone())
            }) {
                base = extend;
            }
        }
        for run in c["_guided_runs"].as_array_mut().into_iter().flatten() {
            approve(run, &base);
        }
    }
}

/// `crate::execute` with the adapter's start-run approval applied.
pub fn execute(db: &NativeStore, mut c: Value) -> yoneda_agents_core::Result<Value> {
    approve_start(db, &mut c);
    crate::execute(db, c)
}

/// Seal the leased producer's approved view (optionally with one staged file) and register it.
pub fn seal(db: &NativeStore, job_id: &str, epoch: i64, now: i64, changed: bool) -> Value {
    let context = call(
        db,
        json!({"op":"source_read_context","job_id":job_id,"epoch":epoch}),
        now,
    );
    let view = SourceView {
        version: 1,
        base: serde_json::from_value(context["base"].clone()).unwrap(),
        files: vec![],
    };
    // Exact dependency paths start absent; a capture reads the premerged bytes itself.
    let paths: std::collections::BTreeSet<String> = context["baseline_inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|input| input["paths"].as_array().cloned().unwrap_or_default())
        .filter_map(|path| path.as_str().map(str::to_owned))
        .collect();
    let overrides: Vec<Value> = paths
        .into_iter()
        .map(|path| json!({"path":path,"file":null}))
        .collect();
    let bound = call(
        db,
        json!({"op":"source_bind","job_id":job_id,"epoch":epoch,"_source_view":view,
            "_source_baseline_overrides":overrides,"_supervisor":true,"_source_signing_key":KEY}),
        now,
    );
    let source = NativeStore::memory().unwrap();
    let actor = bound["actor_grant"].clone();
    let workspace = |mut c: Value| {
        c["now"] = json!(now);
        c["_source_signing_key"] = json!(KEY);
        c["_actor"] = actor.clone();
        source_workspace::execute_source_workspace(&source, c).unwrap()
    };
    workspace(
        json!({"op":"source_init","request_id":"init","binding":bound["binding"],
        "view":view,"baseline_overrides":overrides}),
    );
    if changed {
        let sha = yoneda_agents_core::digest(b"captured source");
        let ticket = workspace(json!({"op":"source_upload_ticket","request_id":"upload",
            "path":"file.txt","sha256":sha,"size":15,"mode":"100644",
            "expected_workspace_version":0,"expected_file_version":0}));
        workspace(json!({"op":"source_verify_upload","request_id":"verify",
            "ticket_id":ticket["ticket"]["id"],"sha256":sha,"size":15}));
        workspace(
            json!({"op":"source_create","request_id":"create","path":"file.txt",
            "ticket_id":ticket["ticket"]["id"],"expected_workspace_version":0,"expected_file_version":0}),
        );
    }
    let version = i64::from(changed);
    let checkpoint = workspace(json!({"op":"source_checkpoint","request_id":"checkpoint",
        "expected_workspace_version":version}));
    let seal = workspace(json!({"op":"source_seal","request_id":"seal",
        "expected_workspace_version":version,"checkpoint_id":checkpoint["checkpoint_id"],
        "expected_checkpoint_digest":checkpoint["changeset_digest"]}));
    call(
        db,
        json!({"op":"source_register_changeset","job_id":job_id,"epoch":epoch,"request_id":"register",
            "view_digest":bound["binding"]["view_digest"],"_source_seal":seal,"_source_signing_key":KEY}),
        now,
    )
}

/// The registration pointer an adapter-verified coding completion reports.
pub fn pointer(registration: &Value) -> Value {
    let b = &registration["binding"];
    json!({"producer_job_id":b["job_id"],"producer_epoch":b["epoch"],
        "registration_id":registration["registration_id"],"changeset_digest":registration["changeset_digest"]})
}

/// Finish a leased coding job through its registered seal; returns the registration.
pub fn finish_agent(db: &NativeStore, job: &Value, now: i64) -> Value {
    let id = job["id"].as_str().unwrap();
    let epoch = job["epoch"].as_i64().unwrap();
    let registration = seal(db, id, epoch, now, false);
    call(
        db,
        json!({"op":"finish","job_id":id,"epoch":epoch,
            "result":{"source_verified":true,"source_registered":pointer(&registration)}}),
        now,
    );
    registration
}

/// Finish the leased coding job `job_id` through its registered seal; `extra` adds result
/// fields (a transcript). Returns the registration.
pub fn finish_job(db: &NativeStore, job_id: &str, now: i64, extra: Value) -> Value {
    let job = crate::storage::get(db, "jobs", job_id).unwrap();
    let epoch = job["epoch"].as_i64().unwrap();
    let registration = seal(db, job_id, epoch, now, false);
    let mut result = json!({"source_verified":true,"source_registered":pointer(&registration)});
    for (key, value) in extra.as_object().into_iter().flatten() {
        result[key] = value.clone();
    }
    call(
        db,
        json!({"op":"finish","job_id":job_id,"epoch":epoch,"result":result}),
        now,
    );
    registration
}

/// A trusted capture result bound to `registration`; `extra` adds readback or provenance.
pub fn capture_result(
    registration: &Value,
    id: &str,
    commit: &str,
    paths: Value,
    extra: Value,
) -> Value {
    let b = &registration["binding"];
    let lineage = json!({"version":1,"authority":"registered_source_changeset",
        "workspace_id":b["workspace_id"],"registration_id":registration["registration_id"],
        "producer_job_id":b["job_id"],"producer_epoch":b["epoch"],"seal_id":registration["seal_id"],
        "checkpoint_id":registration["checkpoint_id"],"changeset_digest":registration["changeset_digest"],
        "view_digest":b["view_digest"],"baseline_overrides_digest":b["baseline_overrides_digest"]});
    let mut result = json!({"id":id,"revision":{"repository":"test/captured","commit":commit},
        "tree":"d".repeat(40),"parents":b["parents"],"paths":paths,"summary":"Checked source capture",
        "source_verified":true,"source_lineage":lineage,
        "source_changeset_digest":registration["changeset_digest"],
        "source_manifest_digest":registration["changeset_digest"]});
    for (key, value) in extra.as_object().into_iter().flatten() {
        result[key] = value.clone();
    }
    result
}

/// `result` (a capture's revision, tree, paths, summary...) bound to `registration`'s lineage.
pub fn with_lineage(registration: &Value, result: Value) -> Value {
    let id = result["id"].as_str().unwrap_or_default().to_owned();
    let commit = result["revision"]["commit"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let paths = result["paths"].clone();
    capture_result(registration, &id, &commit, paths, result)
}
