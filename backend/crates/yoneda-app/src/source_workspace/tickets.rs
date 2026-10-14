use super::*;
pub(super) fn handle<S: SqlStore>(
    db: &S,
    c: &Value,
    state: &mut Value,
    binding: &SourceBinding,
    actor: &ActorGrant,
) -> Result<Value> {
    if c["op"] == "source_verify_upload" {
        return verify(db, c, binding);
    }
    check_version(c, state)?;
    let path = string(c, "path")?;
    binding.authorize_path(&path)?;
    check_file(db, &path, &c["expected_file_version"])?;
    let hash = string(c, "sha256")?;
    validate_hash(&hash, &[64])?;
    let size = c["size"]
        .as_u64()
        .filter(|s| *s <= MAX_FILE_BYTES)
        .ok_or_else(|| bad("Invalid upload size"))?;
    let mode: FileMode = decode(&c["mode"])?;
    let used = state["uploaded_bytes"]
        .as_u64()
        .ok_or_else(|| bad("Invalid upload accounting"))?;
    let total = used
        .checked_add(size)
        .filter(|v| *v <= MAX_UPLOAD_BYTES)
        .ok_or_else(|| Error::new("SOURCE_LIMIT", "Cumulative upload capacity exceeded"))?;
    let id = format!(
        "upload:{}",
        yoneda_core::fingerprint(
            &json!({"workspace":binding.workspace_id,"request_id":c["request_id"]})
        )?
    );
    let expires = number(c, "now")?
        .checked_add(120000)
        .ok_or_else(|| bad("Invalid upload expiry"))?
        .min(actor.claims.expires_at);
    let ticket = json!({"id":id,"key":format!("source/v1/{}/uploads/{id}/{hash}",binding.workspace_id),"path":path,"sha256":hash,"size":size,"mode":mode,"expected_file_version":c["expected_file_version"],"state":"issued","expires_at":expires,"gc_token":null});
    create(db, "sw_tickets", &id, &ticket)?;
    state["uploaded_bytes"] = json!(total);
    Ok(json!({"version":1,"workspace_id":binding.workspace_id,"ticket":ticket}))
}
fn verify<S: SqlStore>(db: &S, c: &Value, binding: &SourceBinding) -> Result<Value> {
    let id = string(c, "ticket_id")?;
    let mut t = get(db, "sw_tickets", &id)?;
    usable(&t, c)?;
    if t["sha256"] != c["sha256"] || t["size"] != c["size"] {
        return Err(Error::new(
            "UPLOAD_MISMATCH",
            "Verified R2 readback differs from ticket",
        ));
    }
    t["state"] = json!("verified");
    save(db, "sw_tickets", &id, &t)?;
    Ok(json!({"version":1,"workspace_id":binding.workspace_id,"ticket":t}))
}
fn usable(t: &Value, c: &Value) -> Result<()> {
    if !matches!(t["state"].as_str(), Some("issued" | "verified")) {
        return Err(Error::new(
            "UPLOAD_UNAVAILABLE",
            "Ticket is committed or fenced for cleanup",
        ));
    }
    if number(c, "now")? >= number(t, "expires_at")? {
        return Err(Error::new("UPLOAD_EXPIRED", "Upload ticket expired"));
    }
    Ok(())
}
pub(super) fn consume<S: SqlStore>(db: &S, c: &Value, path: &str) -> Result<SourceFile> {
    let id = string(c, "ticket_id")?;
    let mut t = get(db, "sw_tickets", &id)?;
    usable(&t, c)?;
    if t["state"] != "verified"
        || t["path"] != path
        || t["expected_file_version"] != c["expected_file_version"]
    {
        return Err(Error::new(
            "UPLOAD_UNAVAILABLE",
            "Ticket is not verified for this exact file version",
        ));
    }
    let size = t["size"]
        .as_u64()
        .ok_or_else(|| bad("Invalid ticket size"))?;
    let file = SourceFile {
        path: path.into(),
        mode: decode(&t["mode"])?,
        size,
        content: ContentRef::R2 {
            key: string(&t, "key")?,
            sha256: string(&t, "sha256")?,
            size,
            ticket_id: id.clone(),
        },
    };
    file.validate()?;
    t["state"] = json!("committed");
    save(db, "sw_tickets", &id, &t)?;
    Ok(file)
}
