use super::*;
#[derive(Clone)]
struct BoundedStore(crate::native::NativeStore);
impl SqlStore for BoundedStore {
    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Value>> {
        if params
            .iter()
            .any(|v| v.as_str().is_some_and(|s| s.len() > 2 * 1024 * 1024))
        {
            return Err(Error::new("SQL_VALUE_LIMIT", "SQLite value exceeds 2MiB"));
        }
        self.0.query(sql, params)
    }
    fn transaction(&self, action: Box<dyn FnOnce() -> Result<Value>>) -> Result<Value> {
        self.0.transaction(action)
    }
}
#[test]
fn source_large_index_persists_rows_not_full_metadata_sql_value() {
    let db = BoundedStore(f::db());
    let mut view = f::view();
    view.files = (0..10000)
        .map(|i| {
            f::file(
                &format!("{i:04}/{}/{}", "x".repeat(240), "y".repeat(240)),
                b"x",
            )
        })
        .collect();
    assert!(serde_json::to_vec(&view).unwrap().len() > 2 * 1024 * 1024);
    let mut binding = f::binding();
    binding.view_digest = view_digest(&view, &[]).unwrap();
    binding.workspace_id = workspace_id(
        &binding.repo_id,
        &binding.job_id,
        binding.epoch,
        &binding.view_digest,
    )
    .unwrap();
    let c = json!({"op":"source_init","request_id":"large-init","now":1000,"_source_signing_key":f::KEY,"_actor":f::actor(&binding,1000,ActorPurpose::Supervisor),"binding":binding,"view":view,"baseline_overrides":[]});
    execute_source_workspace(&db, c.clone()).unwrap();
    assert_eq!(
        db.query("SELECT COUNT(*) AS count FROM sw_baseline", &[])
            .unwrap()[0]["count"],
        10000
    );
    execute_source_workspace(&db, c).unwrap();
    let row = get(&db, "sw_state", "workspace").unwrap();
    assert!(row.get("view").is_none());
    assert!(row.get("baseline_overrides").is_none());
}
#[test]
fn source_large_checkpoint_seal_and_unread_index_remain_paged() {
    let db = BoundedStore(f::db());
    let mut view = f::view();
    view.files = (0..2001)
        .map(|i| {
            f::file(
                &format!("{i:04}/{}/{}", "x".repeat(240), "y".repeat(240)),
                b"x",
            )
        })
        .collect();
    let mut binding = f::binding();
    binding.view_digest = view_digest(&view, &[]).unwrap();
    binding.workspace_id = workspace_id(
        &binding.repo_id,
        &binding.job_id,
        binding.epoch,
        &binding.view_digest,
    )
    .unwrap();
    let actor = f::actor(&binding, 1000, ActorPurpose::Supervisor);
    let call = |mut c: Value| {
        c["now"] = json!(1000);
        c["_source_signing_key"] = json!(f::KEY);
        c["_actor"] = actor.clone();
        execute_source_workspace(&db, c)
    };
    call(json!({"op":"source_init","request_id":"large-init","binding":binding,"view":view,"baseline_overrides":[]})).unwrap();
    // Valid staged rows reproduce a large legitimate delta without 2001 repeated scans in fixture setup.
    db.query(
        "UPDATE sw_files SET payload=json_set(payload,'$.file.mode','100755','$.file_version',1)",
        &[],
    )
    .unwrap();
    let checkpoint = call(
        json!({"op":"source_checkpoint","request_id":"checkpoint","expected_workspace_version":0}),
    )
    .unwrap();
    assert_eq!(checkpoint["change_count"], 2001);
    let sealed=call(json!({"op":"source_seal","request_id":"seal","expected_workspace_version":0,"checkpoint_id":checkpoint["checkpoint_id"],"expected_checkpoint_digest":checkpoint["changeset_digest"]})).unwrap();
    assert!(sealed.to_string().len() < 10000);
    for section in ["changes", "view_files"] {
        let mut cursor = Value::Null;
        let mut count = 0;
        loop {
            let page=call(json!({"op":"source_manifest","checkpoint_id":checkpoint["checkpoint_id"],"section":section,"after":cursor,"limit":200})).unwrap();
            let items = page["items"].as_array().unwrap();
            assert!(items.len() <= 200);
            count += items.len();
            cursor = page["next_cursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(
            count, 2001,
            "No unread metadata or delta after record 2000 may disappear"
        );
    }
    let values = db
        .query("SELECT MAX(length(payload)) AS largest FROM sw_deltas", &[])
        .unwrap();
    assert!(values[0]["largest"].as_i64().unwrap() < 2 * 1024 * 1024);
}
#[test]
fn maintenance_filters_expiry_before_paging_and_never_collects_committed() {
    let db = f::db();
    f::init(&db);
    for i in 0..2002 {
        let id = format!("ticket-{i:04}");
        let ticket = json!({"id":id,"key":format!("source/v1/work/uploads/{id}/hash"),"state":if i==2000{"committed"}else{"issued"},"expires_at":if i>=2000{500}else{900000},"gc_token":null});
        save(&db, "sw_tickets", &id, &ticket).unwrap();
    }
    let due = f::call(&db, json!({"op":"source_gc_due","now":1000,"_actor":null})).unwrap();
    assert_eq!(due["tickets"].as_array().unwrap().len(), 1);
    assert_eq!(due["tickets"][0]["id"], "ticket-2001");
    assert_eq!(due["next_due_at"], 500);
    assert_eq!(f::call(&db,json!({"op":"source_gc_claim","request_id":"gc-committed","ticket_id":"ticket-2000","now":1000,"_gc_grant":due["gc_grant"]})).unwrap_err().code,"FORBIDDEN");
}
