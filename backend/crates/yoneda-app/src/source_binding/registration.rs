use super::*;
pub(super) fn register<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let mut job = active(db, c, now)?;
    let ctx = context::read(db, c, now)?;
    let digest = string(c, "view_digest")?;
    let entry = &job["source_bindings"][&digest];
    let binding: SourceBinding = decode(&entry["binding"])?;
    validate_guard(db, &binding, entry, &ctx)?;
    validate_head(db, &binding)?;
    let seal = &c["_source_seal"];
    let proof: SealAttestation = decode(&seal["attestation"])?;
    source_workspace::verify_seal(&proof, &binding, &string(c, "_source_signing_key")?)?;
    let claims = &proof.claims;
    if seal["seal_id"] != claims.seal_id
        || seal["checkpoint_id"] != claims.checkpoint_id
        || seal["changeset_digest"] != claims.changeset_digest
        || seal["workspace_version"] != claims.workspace_version
        || seal["workspace_id"] != binding.workspace_id
        || binding.access != SourceAccess::ReadWrite
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Source registration differs from attested seal",
        ));
    }
    validate_hash(&claims.changeset_digest, &[64])?;
    validate_id(&claims.seal_id)?;
    validate_id(&claims.checkpoint_id)?;
    let expected = json!(binding);
    let compact: yoneda_core::source_changeset::SourceChangesetHeader =
        decode(&seal["changeset_header"])?;
    let header = json!(compact);
    for field in [
        "version",
        "transport",
        "workspace_id",
        "repo_id",
        "run_id",
        "job_id",
        "epoch",
        "execution_id",
        "view_digest",
        "base",
        "parents",
        "policy_digest",
        "intent_digest",
        "write_paths",
    ] {
        if header[field] != expected[field] {
            return Err(Error::new(
                "FENCED",
                "Changeset header differs from sealed binding",
            ));
        }
    }
    if header["workspace_version"] != claims.workspace_version
        || claims.workspace_version < 0
        || seal["change_count"].as_u64().is_none_or(|n| n > 10000)
        || seal["baseline_override_count"]
            .as_u64()
            .is_none_or(|n| n > 10000)
    {
        return Err(bad("Invalid changeset header bounds"));
    }
    let id = string(c, "request_id")?;
    validate_id(&id)?;
    let registration = json!({"version":1,"registration_id":format!("source-registration:{}",yoneda_core::fingerprint(&json!({"binding":binding.digest()?,"seal":claims.seal_id}))?),"binding":binding,"seal_id":claims.seal_id,"checkpoint_id":claims.checkpoint_id,"changeset_digest":claims.changeset_digest,"workspace_version":claims.workspace_version,"manifest_header":header,"change_count":seal["change_count"],"baseline_override_count":seal["baseline_override_count"],"attestation":proof,"authority":"staged_source","checked":false,"published":false});
    let input = yoneda_core::fingerprint(&registration)?;
    if let Some(old) = job.get("source_registered").filter(|v| !v.is_null()) {
        if old["request_id"] != id || old["fingerprint"] != input {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Source registration is already frozen",
            ));
        }
        return Ok(old["registration"].clone());
    }
    job["source_registered"] =
        json!({"request_id":id,"fingerprint":input,"registration":registration});
    save(db, "jobs", &string(&job, "id")?, &job)?;
    event(
        db,
        "source.changeset_registered",
        now,
        json!({"job_id":job["id"],"workspace_id":binding.workspace_id,"seal_id":claims.seal_id,"changeset_digest":claims.changeset_digest}),
    )?;
    Ok(registration)
}
fn validate_head<S: SqlStore>(db: &S, b: &SourceBinding) -> Result<()> {
    if super::resolution::validate_binding_head(db, b)? {
        return Ok(());
    }
    let r = repo(db)?;
    let run = get(db, "runs", &b.run_id)?;
    let valid = if let Some(id) = &b.working_branch_id {
        let branch = get(db, "working_branches", id)?;
        branch["version"] == json!(b.working_branch_version)
            && branch["working_revision"] == run["base"]
            && branch["working_commit"] == run["base"]["commit"]
    } else {
        r["version"] == b.repo_base_version && r["head_commit"] == run["base"]["commit"]
    };
    if r["status"] != "ready" || !r["pending"].is_null() || !valid {
        return Err(Error::new(
            "HEAD_MOVED",
            "Source registration requires exact approved working base",
        ));
    }
    Ok(())
}
pub(super) fn registered<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let job = get(db, "jobs", &string(c, "job_id")?)?;
    job["source_registered"]
        .get("registration")
        .cloned()
        .ok_or_else(|| Error::new("NOT_FOUND", "Source producer has no registered seal"))
}
pub(super) fn capture_record<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let job = active(db, c, now)?;
    if job["kind"] != "capture" || job["payload"]["capture_subtype"] != "source_changeset" {
        return Err(Error::new(
            "FORBIDDEN",
            "Attempt is not a source changeset capture",
        ));
    }
    let pointer = &job["payload"]["source_registered"];
    let producer = get(db, "jobs", &string(pointer, "producer_job_id")?)?;
    let registration = producer["source_registered"]["registration"].clone();
    if registration.is_null()
        || pointer["registration_id"] != registration["registration_id"]
        || pointer["changeset_digest"] != registration["changeset_digest"]
        || pointer["producer_epoch"] != producer["epoch"]
    {
        return Err(Error::new(
            "FENCED",
            "Capture registration reference changed",
        ));
    }
    let binding: SourceBinding = decode(&registration["binding"])?;
    let run = get(db, "runs", &binding.run_id)?;
    if repo(db)?["policy"] != job["payload"]["policy"]
        || yoneda_core::fingerprint(&job["payload"]["policy"])? != binding.policy_digest
        || ["cancelled", "accepted"].contains(&run["status"].as_str().unwrap_or(""))
    {
        return Err(Error::new("FENCED", "Capture policy or run changed"));
    }
    Ok(
        json!({"version":1,"binding":binding,"seal":{"workspace_id":binding.workspace_id,"seal_id":registration["seal_id"],"checkpoint_id":registration["checkpoint_id"],"changeset_digest":registration["changeset_digest"],"workspace_version":registration["workspace_version"]},"view_digest":binding.view_digest,"base":binding.base,"parents":binding.parents,"baseline_overrides_digest":binding.baseline_overrides_digest,"manifest_header":registration["manifest_header"],"manifest_cursor":null}),
    )
}

pub(super) fn capture<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let mut result = capture_record(db, c, now)?;
    let binding: SourceBinding = decode(&result["binding"])?;
    let job = active(db, c, now)?;
    let claims = CaptureClaims {
        version: 1,
        workspace_id: binding.workspace_id.clone(),
        binding_digest: binding.digest()?,
        seal_id: string(&result["seal"], "seal_id")?,
        checkpoint_id: string(&result["seal"], "checkpoint_id")?,
        changeset_digest: string(&result["seal"], "changeset_digest")?,
        capture_job_id: string(&job, "id")?,
        capture_epoch: number(&job, "epoch")?,
        expires_at: number(&job, "lease_until")?.min(number(&job, "attempt_deadline")?),
        purpose: "read_manifest".into(),
    };
    result["_capture_grant"] = json!(source_workspace::sign_capture(
        claims,
        &string(c, "_source_signing_key")?
    )?);
    Ok(result)
}
