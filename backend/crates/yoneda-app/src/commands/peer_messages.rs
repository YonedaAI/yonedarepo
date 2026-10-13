//! Ordered, bounded same-team messages and platform-written delivery receipts.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(super) fn page<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let run = string(c, "run_id")?;
    get(db, "runs", &run)?;
    let after = c.get("after").and_then(Value::as_i64).unwrap_or(0);
    let limit = c.get("limit").and_then(Value::as_i64).unwrap_or(25);
    let high = number(
        &db.query(
            "SELECT COALESCE(MAX(seq),0) AS seq FROM peer_messages WHERE run_id=?",
            &[json!(run)],
        )?[0],
        "seq",
    )?;
    let watermark = c.get("watermark").and_then(Value::as_i64).unwrap_or(high);
    if after < 0 || !(1..=50).contains(&limit) || !(0..=high).contains(&watermark) {
        return Err(bad("Invalid conversation page"));
    }
    let rows=db.query("SELECT m.seq,m.payload,(SELECT COUNT(*) FROM peer_deliveries d WHERE d.message_seq=m.seq) AS delivered,(SELECT COUNT(*) FROM peer_deliveries d WHERE d.message_seq=m.seq AND d.acknowledged_at IS NOT NULL) AS acknowledged FROM peer_messages m WHERE m.run_id=? AND m.seq>? AND m.seq<=? ORDER BY m.seq LIMIT ?",&[json!(run),json!(after),json!(watermark),json!(limit+1)])?;
    let count = usize::try_from(limit).map_err(|_| bad("Invalid message limit"))?;
    let has_more = rows.len() > count;
    let items=rows.iter().take(count).map(|row|{
        let mut value=decode(row)?;
        value["delivery_receipts"]=json!({"delivered":row["delivered"],"acknowledged":row["acknowledged"],"proves":"delivery and acknowledgement, not understanding"});
        Ok(value)
    }).collect::<Result<Vec<_>>>()?;
    let next = items
        .last()
        .map(|v| v["seq"].clone())
        .unwrap_or(json!(after));
    Ok(json!({"items":items,"has_more":has_more,"next_cursor":next,"watermark":watermark}))
}

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let job = active(db, c, now)?;
    let execution = &job["payload"]["execution"];
    let run = get(db, "runs", &string(execution, "run_id")?)?;
    if job["kind"] != "agent" || job["external"] == true || run["mode"] != "collaborate" {
        return Err(Error::new(
            "FORBIDDEN",
            "Peer communication is scoped to hosted collaborative work",
        ));
    }
    if c["op"] == "peer_message" {
        send(db, c, execution, &run, number(&job, "epoch")?, now)
    } else {
        inbox(db, c, execution, &run, number(&job, "epoch")?, now)
    }
}

fn send<S: SqlStore>(
    db: &S,
    c: &Value,
    e: &Value,
    run: &Value,
    epoch: i64,
    now: i64,
) -> Result<Value> {
    let request = string(c, "request_id")?;
    let recipient = string(c, "recipient")?;
    let kind = string(c, "kind")?;
    let body = string(c, "body")?;
    let references = c.get("context_ids").cloned().unwrap_or(json!([]));
    if request.len() > 128
        || recipient.len() > 256
        || body.len() > 8192
        || !["contract", "question", "finding", "blocker"].contains(&kind.as_str())
        || references.as_array().is_none_or(|v| {
            v.len() > 20 || v.iter().any(|v| v.as_str().is_none_or(|s| s.len() > 256))
        })
    {
        return Err(bad(
            "Peer message has invalid kind or exceeds a bounded field",
        ));
    }
    if !["team", "coordinator"].contains(&recipient.as_str()) {
        let peer = run_executions(db, &string(run, "id")?)?
            .iter()
            .any(|v| v["id"] == recipient || v["team_task"] == recipient);
        let task = get(db, "team_tasks", &recipient).is_ok_and(|v| v["run_id"] == run["id"]);
        if !peer && !task {
            return Err(Error::new("FORBIDDEN", "Recipient is outside this team"));
        }
    }
    for id in references.as_array().into_iter().flatten() {
        get(
            db,
            "nodes",
            id.as_str().ok_or_else(|| bad("Invalid reference"))?,
        )?;
    }
    let id = format!("{}:{epoch}:{request}", string(e, "id")?);
    let fingerprint = yoneda_core::fingerprint(
        &json!({"recipient":recipient,"kind":kind,"body":body,"context_ids":references}),
    )?;
    let old = db.query(
        "SELECT seq,payload FROM peer_messages WHERE id=?",
        &[json!(id)],
    )?;
    if let Some(row) = old.first() {
        let value = decode(row)?;
        if value["fingerprint"] != fingerprint {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Peer message request was reused with different content",
            ));
        }
        return Ok(value);
    }
    let used = db.query("SELECT COUNT(*) AS count FROM peer_messages WHERE json_extract(payload,'$.sender')=? AND json_extract(payload,'$.epoch')=?",&[e["id"].clone(),json!(epoch)])?;
    if number(&used[0], "count")? >= 100 {
        return Err(Error::new(
            "RESOURCE_LIMIT",
            "Attempt peer message quota exhausted",
        ));
    }
    let mut value = json!({"id":id,"run_id":run["id"],"sender":e["id"],"epoch":epoch,"recipient":recipient,"kind":kind,"body":body,"context_ids":references,"fingerprint":fingerprint,"created_at":now,"authority":"assertion"});
    let row = db.query(
        "INSERT INTO peer_messages(id,run_id,recipient,payload) VALUES(?,?,?,?) RETURNING seq",
        &[
            json!(id),
            run["id"].clone(),
            json!(recipient),
            json!(value.to_string()),
        ],
    )?;
    value["seq"] = row[0]["seq"].clone();
    db.query(
        "UPDATE peer_messages SET payload=? WHERE id=?",
        &[json!(value.to_string()), json!(id)],
    )?;
    event(db, "peer.message", now, value.clone())?;
    Ok(value)
}

fn inbox<S: SqlStore>(
    db: &S,
    c: &Value,
    e: &Value,
    run: &Value,
    epoch: i64,
    now: i64,
) -> Result<Value> {
    let after = c
        .get("after")
        .map(|v| v.as_i64().ok_or_else(|| bad("Invalid message cursor")))
        .transpose()?
        .unwrap_or(0);
    let limit = c
        .get("limit")
        .map(|v| v.as_i64().ok_or_else(|| bad("Invalid message limit")))
        .transpose()?
        .unwrap_or(25);
    if after < 0 || !(1..=50).contains(&limit) {
        return Err(bad("Inbox needs nonnegative cursor and limit 1–50"));
    }
    let coordinator = ["planner", "coordinator", "integrator"]
        .contains(&e["team_role"].as_str().unwrap_or_default());
    let rows=db.query("SELECT seq,payload FROM peer_messages WHERE run_id=? AND seq>? AND (recipient IN ('team',?,?) OR (?=1 AND recipient='coordinator')) ORDER BY seq LIMIT ?",&[run["id"].clone(),json!(after),e["id"].clone(),e["team_task"].clone(),json!(i64::from(coordinator)),json!(limit+1)])?;
    let more = rows.len() > usize::try_from(limit).map_err(|_| bad("Invalid limit"))?;
    let mut items = Vec::new();
    for row in rows
        .iter()
        .take(usize::try_from(limit).map_err(|_| bad("Invalid limit"))?)
    {
        let value = decode(row)?;
        db.query("INSERT OR IGNORE INTO peer_deliveries(message_seq,execution_id,epoch,delivered_at) VALUES(?,?,?,?)",&[row["seq"].clone(),e["id"].clone(),json!(epoch),json!(now)])?;
        items.push(value);
    }
    if let Some(ids) = c.get("ack_ids") {
        let ids = ids
            .as_array()
            .filter(|v| v.len() <= 50)
            .ok_or_else(|| bad("At most 50 message acknowledgements"))?;
        for seq in ids {
            let seq = seq
                .as_i64()
                .filter(|v| *v > 0)
                .ok_or_else(|| bad("Invalid acknowledgement"))?;
            let rows=db.query("UPDATE peer_deliveries SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE message_seq=? AND execution_id=? AND epoch=? RETURNING message_seq",&[json!(now),json!(seq),e["id"].clone(),json!(epoch)])?;
            if rows.is_empty() {
                return Err(Error::new(
                    "FORBIDDEN",
                    "Cannot acknowledge an undelivered message",
                ));
            }
        }
    }
    let next = items
        .last()
        .map(|v| v["seq"].clone())
        .unwrap_or(json!(after));
    Ok(
        json!({"items":items,"next_cursor":next,"has_more":more,"delivery_authority":"platform_delivery","coverage":"same run; delivery does not prove understanding"}),
    )
}

fn decode(row: &Value) -> Result<Value> {
    serde_json::from_str(
        row["payload"]
            .as_str()
            .ok_or_else(|| bad("Corrupt message"))?,
    )
    .map_err(|e| bad(&e.to_string()))
}
