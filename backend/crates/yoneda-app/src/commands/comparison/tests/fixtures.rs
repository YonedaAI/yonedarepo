use super::*;
use crate::commands::run_kit;
use crate::native::NativeStore;
pub(super) fn call(db: &NativeStore, mut input: Value) -> Result<Value> {
    if input.get("now").is_none() {
        input["now"] = json!(1000);
    }
    run_kit::approve_start(db, &mut input);
    crate::execute(db, input)
}
pub(super) fn db() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"init","id":"compare-repo","name":"Compare fixture","remote":{"namespace":"test","name":"compare"},"commit":"a".repeat(40),"policy":{"version":"compare-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}})).unwrap();
    db
}
pub(super) fn budget(provider: &str, model: &str) -> Value {
    json!({"provider":provider,"model":model,"max_requests":144,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":50000000,"pricing":{"input_microusd_per_million":100000,"output_microusd_per_million":200000,"source":"owner-approved conservative rates"}})
}
pub(super) fn input() -> Value {
    json!({"op":"start_run","id":"compare","intent":"Compare safe booking implementations","criteria":["No double booking"],"mode":"compare","agents":[{"provider":"zai","model":"glm-5.3-flash","connection":"zai","strategy":"minimal"},{"provider":"zai","model":"glm-4.7-flash","connection":"zai","strategy":"defensive"}],"model_budgets":[budget("zai","glm-5.3-flash"),budget("zai","glm-4.7-flash")]})
}
pub(super) fn candidate(db: &NativeStore, index: usize, commit: &str) -> String {
    let eid = format!("compare:agent-{index}");
    finish_candidate(db, &eid, &format!("candidate-{index}"), commit)
}
pub(super) fn finish_candidate(db: &NativeStore, eid: &str, cid: &str, commit: &str) -> String {
    if get(db, "jobs", &format!("job:{eid}")).unwrap()["status"] != "running" {
        call(db, json!({"op":"claim","job_id":format!("job:{eid}")})).unwrap();
    }
    let job = get(db, "jobs", &format!("job:{eid}")).unwrap();
    run_kit::land(
        db,
        job["id"].as_str().unwrap(),
        1000,
        json!({"id":cid,"revision":{"repository":"test/compare","commit":commit},"tree":"f".repeat(40),"paths":["src/booking.rs"],"summary":"Booking implementation","diff_digest":"d".repeat(64)}),
    );
    call(db, json!({"op":"claim","job_id":format!("evaluate:{cid}")})).unwrap();
    let p = repo(db).unwrap()["policy"].clone();
    call(db,json!({"op":"finish","job_id":format!("evaluate:{cid}"),"epoch":1,"result":{"id":format!("evaluation-{cid}"),"candidate":cid,"revision":{"repository":"test/compare","commit":commit},"policy":p["version"],"suite":p["suite"],"environment":p["environment"],"evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":"Synthetic native fixture"}]}})).unwrap();
    cid.to_owned()
}
