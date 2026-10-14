use super::*;
pub(super) fn due<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let key = string(c, "_source_signing_key")?;
    validate_hash(&key, &[64])?;
    let state = match get(db, "sw_state", "workspace") {
        Ok(s) => s,
        Err(e) if e.code == "NOT_FOUND" => {
            return Ok(json!({"version":1,"pending":false,"tickets":[],"next_due_at":null}));
        }
        Err(e) => return Err(e),
    };
    let binding: SourceBinding = decode(&state["binding"])?;
    let now = number(c, "now")?;
    let summary=db.query("SELECT COUNT(*) AS count,MIN(CASE WHEN json_extract(payload,'$.state')='gc_pending' THEN ? ELSE json_extract(payload,'$.expires_at') END) AS next_due FROM sw_tickets WHERE json_extract(payload,'$.state') IN ('issued','verified','gc_pending')",&[json!(now)])?;
    let aggregate = summary
        .first()
        .ok_or_else(|| bad("Missing ticket summary"))?;
    let pending = aggregate["count"]
        .as_i64()
        .ok_or_else(|| bad("Invalid ticket count"))?
        > 0;
    let rows=db.query("SELECT payload FROM sw_tickets WHERE json_extract(payload,'$.state')='gc_pending' OR (json_extract(payload,'$.state') IN ('issued','verified') AND json_extract(payload,'$.expires_at')<=?) ORDER BY id LIMIT 50",&[json!(now)])?;
    let mut tickets = Vec::new();
    for row in rows {
        let t = rows::payload(&row)?;
        tickets.push(json!({"id":t["id"],"key":t["key"],"state":t["state"],"expires_at":t["expires_at"],"gc_token":t["gc_token"]}));
    }
    let expiry = now
        .checked_add(60000)
        .ok_or_else(|| bad("Invalid maintenance expiry"))?;
    Ok(
        json!({"version":1,"workspace_id":binding.workspace_id,"repo_id":binding.repo_id,"binding_digest":binding.digest()?,"pending":pending,"tickets":tickets,"gc_grant":auth::sign_gc(&binding,expiry,&key)?,"next_due_at":aggregate["next_due"]}),
    )
}
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, _: &Value) -> Result<Value> {
    if let Some(receipt) = replay(db, c)? {
        return Ok(receipt);
    }
    let id = string(c, "ticket_id")?;
    let mut ticket = get(db, "sw_tickets", &id)?;
    let receipt = match c["op"].as_str() {
        Some("source_gc_claim") => {
            if !matches!(
                ticket["state"].as_str(),
                Some("issued" | "verified" | "gc_pending")
            ) {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Committed or deleted upload cannot be collected",
                ));
            }
            if number(c, "now")? < number(&ticket, "expires_at")? {
                return Err(Error::new("NOT_DUE", "Upload ticket is not expired"));
            }
            if ticket["gc_token"].is_null() {
                ticket["gc_token"] = json!(yoneda_core::fingerprint(
                    &json!({"ticket":id,"request":c["request_id"],"purpose":"gc"})
                )?);
            }
            ticket["state"] = json!("gc_pending");
            json!({"ticket_id":id,"key":ticket["key"],"state":"gc_pending","gc_token":ticket["gc_token"]})
        }
        Some("source_gc_complete") => {
            if ticket["state"] != "gc_pending"
                || ticket["gc_token"] != c["gc_token"]
                || c["observed_missing"] != true
            {
                return Err(Error::new(
                    "FENCED",
                    "Cleanup requires exact claim and missing-object readback",
                ));
            }
            ticket["state"] = json!("deleted");
            json!({"ticket_id":id,"state":"deleted"})
        }
        _ => {
            return Err(Error::new(
                "NOT_FOUND",
                "Unknown source maintenance operation",
            ));
        }
    };
    save(db, "sw_tickets", &id, &ticket)?;
    let request = string(c, "request_id")?;
    validate_id(&request)?;
    create(
        db,
        "sw_receipts",
        &request,
        &json!({"id":request,"fingerprint":state::fingerprint(c)?,"receipt":receipt}),
    )?;
    db.query(
        "INSERT INTO sw_events(payload) VALUES(?)",
        &[json!(
            json!({"kind":c["op"],"request_id":request,"ticket_id":id}).to_string()
        )],
    )?;
    Ok(receipt)
}
