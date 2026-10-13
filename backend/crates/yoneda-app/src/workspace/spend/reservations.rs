use super::*;

fn identity(c: &Value) -> Result<Value> {
    let v = &c["identity"];
    for field in [
        "repo_id",
        "run_id",
        "job_id",
        "provider",
        "model",
        "ledger_reservation_id",
    ] {
        let s = string(v, field)?;
        if s.is_empty() || s.len() > 512 {
            return Err(bad("Invalid allowance reservation identity"));
        }
    }
    for field in ["epoch", "request_number"] {
        if number(v, field)? < 1 {
            return Err(bad("Invalid allowance attempt counter"));
        }
    }
    let keys = [
        "repo_id",
        "run_id",
        "job_id",
        "epoch",
        "request_number",
        "provider",
        "model",
        "ledger_reservation_id",
    ];
    if v.as_object().is_none_or(|o| o.len() != keys.len()) {
        return Err(bad("Unexpected allowance identity fields"));
    }
    Ok(v.clone())
}
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, state: &mut Value, now: i64) -> Result<()> {
    let id = super::super::campaign::identifier(c, "id")?;
    let key = format!("workspace-spend:reservation:{id}");
    let identity = identity(c)?;
    let amount = money(c, "amount")?;
    let existing = optional(db, &key)?;
    if c["op"] == "workspace_spend_reserve" {
        if let Some(old) = existing {
            if old["identity"] != identity || old["reserved_microusd"] != amount {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Allowance reservation identity is immutable",
                ));
            }
            return Ok(());
        }
        if optional(db, &format!("reservation:{id}"))?.is_some()
            || optional(db, &format!("campaign-reservation:{id}"))?.is_some()
        {
            return Err(Error::new(
                "WORKSPACE_SPEND_RECONCILIATION_REQUIRED",
                "Reservation identity already belongs to retained historical spend",
            ));
        }
        let before = status(db, state)?;
        if amount > money(&before, "remaining_microusd")? {
            return Err(Error::new(
                "WORKSPACE_SPEND_EXHAUSTED",
                "Shared workspace allowance exhausted",
            ));
        }
        let reservation = json!({"identity":identity,"reserved_microusd":amount,"status":"reserved","created_at":now});
        create(db, TABLE, &key, &reservation)?;
        state["reserved_microusd"] = json!(add(money(state, "reserved_microusd")?, amount)?);
        put(db, STATE, state)?;
        audit(
            db,
            "workspace_spend.reserved",
            now,
            json!({"id":id,"amount":amount,"identity":identity}),
        )?;
        return Ok(());
    }
    let mut reservation =
        existing.ok_or_else(|| Error::new("NOT_FOUND", "Allowance reservation does not exist"))?;
    if reservation["identity"] != identity {
        return Err(Error::new(
            "FORBIDDEN",
            "Allowance settlement belongs to another attempt",
        ));
    }
    let input = money(c, "input_tokens")?;
    let output = money(c, "output_tokens")?;
    if amount > money(&reservation, "reserved_microusd")? {
        return Err(bad("Allowance settlement exceeds its reservation"));
    }
    let usage = json!({"amount":amount,"input_tokens":input,"output_tokens":output});
    if reservation["status"] == "settled" {
        if reservation["usage"] != usage {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Allowance settlement is immutable",
            ));
        }
        return Ok(());
    }
    state["reserved_microusd"] = json!(
        money(state, "reserved_microusd")?
            .checked_sub(money(&reservation, "reserved_microusd")?)
            .filter(|v| *v >= 0)
            .ok_or_else(|| bad("Allowance reservation underflow"))?
    );
    state["charged_microusd"] = json!(add(money(state, "charged_microusd")?, amount)?);
    reservation["status"] = json!("settled");
    reservation["usage"] = usage;
    reservation["settled_at"] = json!(now);
    put(db, &key, &reservation)?;
    put(db, STATE, state)?;
    audit(
        db,
        "workspace_spend.settled",
        now,
        json!({"id":id,"amount":amount}),
    )?;
    Ok(())
}
