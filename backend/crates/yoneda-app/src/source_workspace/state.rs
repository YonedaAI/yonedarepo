use super::*;
pub(super) fn status(state: &Value, purpose: ActorPurpose) -> Value {
    let b = &state["binding"];
    let mut value = json!({"version":1,"capabilities":{"source_api":1},"transport":TRANSPORT,"workspace_id":b["workspace_id"],"workspace_version":state["workspace_version"],"status":state["status"],"base":b["base"],"view_digest":b["view_digest"],"access":b["access"],"scratch_paths":b["scratch_paths"].as_array().cloned().unwrap_or_default(),"latest_checkpoint_id":state["latest_checkpoint_id"],"seal_id":state["seal"]["seal_id"],"authority":"staged_source","checked":false,"published":false});
    if purpose == ActorPurpose::Supervisor && !state["seal"].is_null() {
        value["seal_receipt"] = state["seal"].clone();
    }
    value
}
pub(super) fn init<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let binding: SourceBinding = decode(&c["binding"])?;
    binding.validate()?;
    let actor = auth::actor(c, &binding)?;
    match get(db, "sw_state", "workspace") {
        Ok(existing) => {
            if existing["binding"] != json!(binding)
                || existing["init_fingerprint"] != fingerprint(c)?
            {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Frozen source view cannot be replaced",
                ));
            }
            if let Some(receipt) = replay(db, c)? {
                return Ok(receipt);
            }
            return Err(Error::new(
                "ALREADY_EXISTS",
                "Source workspace is already initialized",
            ));
        }
        Err(e) if e.code == "NOT_FOUND" => {}
        Err(e) => return Err(e),
    }
    let view: SourceView = decode(&c["view"])?;
    let overrides: Vec<BaselineOverride> =
        decode(c.get("baseline_overrides").unwrap_or(&json!([])))?;
    if view.base != binding.base
        || view_digest(&view, &overrides)? != binding.view_digest
        || yoneda_core::fingerprint(&json!(overrides))? != binding.baseline_overrides_digest
    {
        return Err(Error::new(
            "FENCED",
            "Source view differs from its signed binding",
        ));
    }
    let files = merged_baseline(&view, &overrides)?;
    let permitted = scratch_paths_for(&files, binding.role);
    if binding.scratch_paths.iter().any(|p| !permitted.contains(p)) {
        return Err(Error::new(
            "INVALID_SOURCE",
            "Scratch prefix would shadow frozen source",
        ));
    }
    for file in files.values() {
        match &file.content {
            ContentRef::Git {
                repository, commit, ..
            } if binding
                .inputs
                .iter()
                .any(|r| r.repository == *repository && r.commit == *commit) => {}
            _ => {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Baseline content is outside approved Git inputs",
                ));
            }
        }
        let row = json!({"id":file.path,"file_version":0,"file":file});
        create(db, "sw_files", &file.path, &row)?;
        create(db, "sw_baseline", &file.path, &json!(file))?;
    }
    for file in &view.files {
        create(db, "sw_view_files", &file.path, &json!(file))?;
    }
    for item in &overrides {
        create(db, "sw_overrides", &item.path, &json!(item))?;
    }
    let mut state = json!({"id":"workspace","binding":binding,"init_fingerprint":fingerprint(c)?,"workspace_version":0,"status":"open","uploaded_bytes":0,"request_count":0,"latest_checkpoint_id":null,"seal":null});
    create(db, "sw_state", "workspace", &state)?;
    let receipt = status(&state, actor.claims.purpose);
    record(db, c, &mut state, &receipt)?;
    Ok(receipt)
}
pub(super) fn replay<S: SqlStore>(db: &S, c: &Value) -> Result<Option<Value>> {
    let id = string(c, "request_id")?;
    validate_id(&id)?;
    match get(db, "sw_receipts", &id) {
        Ok(value) => {
            if value["fingerprint"] != fingerprint(c)? {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Source request ID was used with different input",
                ));
            }
            Ok(Some(value["receipt"].clone()))
        }
        Err(e) if e.code == "NOT_FOUND" => Ok(None),
        Err(e) => Err(e),
    }
}
pub(super) fn fingerprint(c: &Value) -> Result<String> {
    let mut public = c.clone();
    public
        .as_object_mut()
        .ok_or_else(|| bad("Invalid source command"))?
        .retain(|k, _| k != "now" && !k.starts_with('_'));
    yoneda_core::fingerprint(&public)
}
pub(super) fn record<S: SqlStore>(
    db: &S,
    c: &Value,
    state: &mut Value,
    receipt: &Value,
) -> Result<()> {
    let limit = i64::try_from(MAX_REQUESTS).map_err(|_| bad("Invalid request limit"))?;
    let count = number(state, "request_count")?
        .checked_add(1)
        .filter(|n| *n <= limit)
        .ok_or_else(|| Error::new("SOURCE_LIMIT", "Source request limit reached"))?;
    state["request_count"] = json!(count);
    let id = string(c, "request_id")?;
    validate_id(&id)?;
    create(
        db,
        "sw_receipts",
        &id,
        &json!({"id":id,"fingerprint":fingerprint(c)?,"receipt":receipt}),
    )?;
    let paths = ["path", "from", "to"]
        .iter()
        .filter_map(|k| c[*k].as_str())
        .collect::<Vec<_>>();
    db.query("INSERT INTO sw_events(payload) VALUES(?)",&[json!(json!({"workspace_version":state["workspace_version"],"kind":c["op"],"request_id":id,"paths":paths}).to_string())])?;
    save(db, "sw_state", "workspace", state)
}
pub(super) fn check_version(c: &Value, state: &Value) -> Result<()> {
    if c["expected_workspace_version"] != state["workspace_version"] {
        return Err(Error::new(
            "VERSION_CONFLICT",
            format!(
                "Current workspace version is {}",
                state["workspace_version"]
            ),
        ));
    }
    Ok(())
}
pub(super) fn row<S: SqlStore>(db: &S, path: &str) -> Result<Value> {
    yoneda_core::validate_path(path)?;
    match get(db, "sw_files", path) {
        Ok(value) => Ok(value),
        Err(e) if e.code == "NOT_FOUND" => Ok(json!({"id":path,"file_version":0,"file":null})),
        Err(e) => Err(e),
    }
}
pub(super) fn check_file<S: SqlStore>(db: &S, path: &str, expected: &Value) -> Result<Value> {
    let value = row(db, path)?;
    if expected != &value["file_version"] {
        return Err(Error::new(
            "FILE_VERSION_CONFLICT",
            format!("Source file version changed for {path}"),
        ));
    }
    Ok(value)
}
pub(super) fn files<S: SqlStore>(db: &S) -> Result<std::collections::BTreeMap<String, SourceFile>> {
    rows::bounded(db, "sw_files", MAX_FILES + 2 * MAX_REQUESTS)?
        .iter()
        .filter(|r| !r["file"].is_null())
        .map(|r| {
            let file: SourceFile = decode(&r["file"])?;
            Ok((file.path.clone(), file))
        })
        .collect()
}
