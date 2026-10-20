use super::*;
use std::collections::BTreeMap;
pub(super) fn handle<S: SqlStore>(
    db: &S,
    c: &Value,
    state: &mut Value,
    binding: &SourceBinding,
) -> Result<Value> {
    check_version(c, state)?;
    if c["op"] == "source_seal" {
        return seal(db, c, state, binding);
    }
    let current = files(db)?;
    let baseline = rows::bounded(db, "sw_baseline", MAX_FILES)?
        .into_iter()
        .map(|v| {
            let f: SourceFile = decode(&v)?;
            Ok((f.path.clone(), f))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    let overrides = rows::bounded(db, "sw_overrides", MAX_FILES)?
        .iter()
        .map(decode)
        .collect::<Result<Vec<BaselineOverride>>>()?;
    let paths = baseline
        .keys()
        .chain(current.keys())
        .collect::<std::collections::BTreeSet<_>>();
    let changes = paths
        .into_iter()
        .filter_map(|p| {
            let before = baseline.get(p).cloned();
            let after = current.get(p).cloned();
            (before != after).then(|| SourceChange {
                path: p.clone(),
                before,
                after,
            })
        })
        .collect();
    let changeset = SourceChangeset {
        version: 1,
        transport: TRANSPORT.into(),
        workspace_id: binding.workspace_id.clone(),
        repo_id: binding.repo_id.clone(),
        run_id: binding.run_id.clone(),
        job_id: binding.job_id.clone(),
        epoch: binding.epoch,
        execution_id: binding.execution_id.clone(),
        view_digest: binding.view_digest.clone(),
        baseline_overrides: overrides,
        base: binding.base.clone(),
        parents: binding.parents.clone(),
        workspace_version: number(state, "workspace_version")?,
        policy_digest: binding.policy_digest.clone(),
        intent_digest: binding.intent_digest.clone(),
        write_paths: binding.write_paths.clone(),
        changes,
    };
    changeset.validate(binding)?;
    let digest = changeset.digest()?;
    let id = format!(
        "checkpoint:{}",
        yoneda_agents_core::fingerprint(
            &json!({"workspace":binding.workspace_id,"version":changeset.workspace_version,"digest":digest})
        )?
    );
    let mut header = json!(changeset);
    header
        .as_object_mut()
        .ok_or_else(|| bad("Invalid changeset"))?
        .remove("changes");
    header
        .as_object_mut()
        .ok_or_else(|| bad("Invalid changeset"))?
        .remove("baseline_overrides");
    let receipt = json!({"version":1,"workspace_id":binding.workspace_id,"workspace_version":state["workspace_version"],"checkpoint_id":id,"changeset_digest":digest,"changeset_header":header,"change_count":changeset.changes.len(),"baseline_override_count":changeset.baseline_overrides.len(),"authority":"staged_source"});
    match get(db, "sw_checkpoints", &id) {
        Ok(old) => {
            if old != receipt {
                return Err(Error::new("FENCED", "Checkpoint identity collision"));
            }
        }
        Err(e) if e.code == "NOT_FOUND" => {
            let rows = db.query("SELECT COUNT(*) AS count FROM sw_checkpoints", &[])?;
            if rows
                .first()
                .and_then(|r| r["count"].as_u64())
                .is_none_or(|n| n >= u64::try_from(MAX_CHECKPOINTS).unwrap_or(0))
            {
                return Err(Error::new("SOURCE_LIMIT", "Checkpoint count exceeded"));
            }
            create(db, "sw_checkpoints", &id, &receipt)?;
            for change in &changeset.changes {
                db.query(
                    "INSERT INTO sw_deltas(checkpoint_id,path,payload) VALUES(?,?,?)",
                    &[
                        json!(id),
                        json!(change.path),
                        json!(json!(change).to_string()),
                    ],
                )?;
            }
        }
        Err(e) => return Err(e),
    }
    state["latest_checkpoint_id"] = json!(id);
    Ok(receipt)
}
fn seal<S: SqlStore>(db: &S, c: &Value, state: &mut Value, b: &SourceBinding) -> Result<Value> {
    let id = string(c, "checkpoint_id")?;
    let checkpoint = get(db, "sw_checkpoints", &id)?;
    if checkpoint["workspace_version"] != state["workspace_version"]
        || checkpoint["changeset_digest"] != c["expected_checkpoint_digest"]
    {
        return Err(Error::new(
            "VERSION_CONFLICT",
            "Seal requires exact current checkpoint",
        ));
    }
    let seal_id = format!(
        "seal:{}",
        yoneda_agents_core::fingerprint(&json!({"binding":b.digest()?,"checkpoint":id}))?
    );
    let claims = SealClaims {
        version: 1,
        workspace_id: b.workspace_id.clone(),
        binding_digest: b.digest()?,
        seal_id: seal_id.clone(),
        checkpoint_id: id,
        changeset_digest: string(&checkpoint, "changeset_digest")?,
        workspace_version: number(state, "workspace_version")?,
        job_id: b.job_id.clone(),
        epoch: b.epoch,
    };
    let mut receipt = checkpoint;
    receipt["seal_id"] = json!(seal_id);
    receipt["attestation"] = json!(auth::seal(claims, &string(c, "_source_signing_key")?)?);
    state["status"] = json!("sealed");
    state["seal"] = receipt.clone();
    Ok(receipt)
}
pub(super) fn manifest<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = string(c, "checkpoint_id")?;
    let checkpoint = get(db, "sw_checkpoints", &id)?;
    let section = string(c, "section")?;
    let after = c["after"].as_str().unwrap_or("");
    if !after.is_empty() {
        yoneda_agents_core::validate_path(after)?;
    }
    let limit = c["limit"].as_i64().unwrap_or(50);
    if !(1..=200).contains(&limit) {
        return Err(bad("Manifest page limit must be 1–200"));
    }
    let (sql, params) = match section.as_str() {
        "changes" => (
            "SELECT payload FROM sw_deltas WHERE checkpoint_id=? AND path>? ORDER BY path LIMIT ?",
            vec![json!(id), json!(after), json!(limit + 1)],
        ),
        "baseline_overrides" => (
            "SELECT payload FROM sw_overrides WHERE id>? ORDER BY id LIMIT ?",
            vec![json!(after), json!(limit + 1)],
        ),
        "view_files" => (
            "SELECT payload FROM sw_view_files WHERE id>? ORDER BY id LIMIT ?",
            vec![json!(after), json!(limit + 1)],
        ),
        _ => return Err(bad("Unknown sealed manifest section")),
    };
    let rows = db.query(sql, &params)?;
    let count = usize::try_from(limit).map_err(|_| bad("Invalid manifest limit"))?;
    let more = rows.len() > count;
    let items = rows
        .iter()
        .take(count)
        .map(rows::payload)
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"checkpoint_id":id,"changeset_digest":checkpoint["changeset_digest"],"section":section,"items":items,"next_cursor":if more{items.last().map(|v|v["path"].clone())}else{None},"has_more":more}),
    )
}
