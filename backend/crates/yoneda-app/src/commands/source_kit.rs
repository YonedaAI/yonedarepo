//! Test kit: drive a leased job through the real API source seal, registration and capture
//! commands. The SOURCES store is a separate native authority, as in the Worker.
use crate::native::NativeStore;
use crate::source_workspace;
use serde_json::{Value, json};
use yoneda_core::source_workspace::SourceView;

pub(crate) const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn call(db: &NativeStore, mut c: Value, now: i64) -> Value {
    c["now"] = json!(now);
    crate::execute(db, c).unwrap()
}

/// Seal the leased producer's approved view (optionally with one staged file) and register it.
pub(crate) fn seal(db: &NativeStore, job_id: &str, epoch: i64, now: i64, changed: bool) -> Value {
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
    let overrides: Vec<Value> = context["baseline_inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|input| input["paths"].as_array().cloned().unwrap_or_default())
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
        let sha = yoneda_core::digest(b"captured source");
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
pub(crate) fn pointer(registration: &Value) -> Value {
    let b = &registration["binding"];
    json!({"producer_job_id":b["job_id"],"producer_epoch":b["epoch"],
        "registration_id":registration["registration_id"],"changeset_digest":registration["changeset_digest"]})
}

/// Finish a leased coding job through its registered seal; returns the registration.
pub(crate) fn finish_agent(db: &NativeStore, job: &Value, now: i64) -> Value {
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

/// A trusted capture result bound to `registration`; `extra` adds readback or provenance.
pub(crate) fn capture_result(
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
