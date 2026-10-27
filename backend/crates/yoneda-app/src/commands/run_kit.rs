//! Test kit: what the Worker adds to an owner's run start (the sandbox transport and its
//! approved frozen base), and a sandbox attempt finishing with its pushed commit.
use crate::native::NativeStore;
use serde_json::{Value, json};

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

/// The adapter's start-run approval: the sandbox transport and its frozen base (the working
/// branch head, else the published commit). A command that names a transport is left alone.
pub(crate) fn approve_start(db: &NativeStore, c: &mut Value) {
    if c["op"] != "start_run" || c.get("workspace_transport").is_some() {
        return;
    }
    let base = working(db, c["working_branch_id"].as_str()).unwrap_or_else(|| published(db));
    c["workspace_transport"] = json!(super::sandbox::TRANSPORT);
    c["_source_transport_approved"] = json!(true);
    c["_source_base"] =
        json!({"repository":base["repository"],"commit":base["commit"],"tree":"b".repeat(40)});
}

/// `crate::execute` with the adapter's start-run approval applied.
pub(crate) fn execute(db: &NativeStore, mut c: Value) -> yoneda_agents_core::Result<Value> {
    approve_start(db, &mut c);
    crate::execute(db, c)
}

/// Finishes the claimed sandbox attempt `job_id` with its pushed commit. `result` carries the
/// candidate (`id`, `revision.commit`, `tree`, `paths`, `summary`...); its repository and
/// parent are the attempt's frozen base, as the sandbox pushes them.
pub(crate) fn land(db: &NativeStore, job_id: &str, now: i64, mut result: Value) -> Value {
    let job = crate::storage::get(db, "jobs", job_id).unwrap();
    let base = &job["payload"]["execution"]["base"];
    result["revision"]["repository"] = base["repository"].clone();
    result["parents"] = json!([base["commit"]]);
    crate::execute(
        db,
        json!({"op":"sandbox_finish","job_id":job_id,"epoch":job["epoch"],"result":result,"now":now}),
    )
    .unwrap()
}
