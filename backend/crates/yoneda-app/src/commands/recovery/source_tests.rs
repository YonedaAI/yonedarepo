//! A run row with one queued coding job, for refresh and conflict-path tests.
use super::*;
use crate::native::NativeStore;
pub(in crate::commands) fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"init","id":"repo","name":"Source integration","remote":{"namespace":"test","name":"source"},"commit":"a".repeat(40),"policy":yoneda_agents_core::Policy::default()}),1000).unwrap();
    let base = json!({"repository":"test/source","commit":"a".repeat(40)});
    let policy = repo(&db).unwrap()["policy"].clone();
    let run = json!({"id":"run","intent":"Build safely","criteria":[],"context":[],"base":base,"source_base":{"repository":"test/source","commit":"a".repeat(40),"tree":"b".repeat(40)},"base_version":0,"status":"exploring","mode":"collaborate","policy":policy,"workspace_transport":"api-source-v1","model_requests":0});
    save(&db, "runs", "run", &run).unwrap();
    let execution = json!({"id":"execution","run_id":"run","harness":"codex","provider":"codex","model":"gpt-5.6-luna","connection":"codex","role":"coding","status":"queued","base":base,"depth":0});
    save(&db, "executions", "execution", &execution).unwrap();
    job(&db,"job:execution","agent",1000,json!({"execution":execution,"run":run,"policy":policy,"workspace_transport":"api-source-v1"})).unwrap();
    db
}
pub(in crate::commands) fn call(db: &NativeStore, mut c: Value, now: i64) -> Result<Value> {
    c["now"] = json!(now);
    crate::execute(db, c)
}
