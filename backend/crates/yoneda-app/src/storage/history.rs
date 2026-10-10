use super::{SqlStore, bad, get, repo};
use serde_json::{Value, json};
use yoneda_core::Result;
const MAX_SAFE_JS_INTEGER: i64 = 9_007_199_254_740_991;

pub(crate) fn checked_watermark(value: i64) -> Result<i64> {
    if !(0..=MAX_SAFE_JS_INTEGER).contains(&value) {
        return Err(bad("History watermark exceeds the safe integer range"));
    }
    Ok(value)
}

pub(crate) fn prune_outbox_payloads<S: SqlStore>(db: &S, now: i64) -> Result<Value> {
    let cutoff = now.saturating_sub(7 * 24 * 60 * 60 * 1000);
    let rows=db.query("UPDATE outbox SET payload='{}',payload_pruned=1 WHERE delivered=1 AND payload_pruned=0 AND created_at>0 AND created_at<? RETURNING id", &[json!(cutoff)])?;
    Ok(json!({"pruned_payloads":rows.len(),"replay_guards_retained":true}))
}
pub(crate) fn repository_overview<S: SqlStore>(db: &S) -> Result<Value> {
    let r = repo(db)?;
    let counts = |table: &str| -> Result<i64> {
        Ok(
            db.query(&format!("SELECT COUNT(*) AS count FROM {table}"), &[])?[0]["count"]
                .as_i64()
                .unwrap_or_default(),
        )
    };
    let seq = checked_watermark(
        db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events", &[])?[0]["seq"]
            .as_i64()
            .unwrap_or_default(),
    )?;
    Ok(
        json!({"repository":r,"counts":{"runs":counts("runs")?,"executions":counts("executions")?,"candidates":counts("candidates")?,"evaluations":counts("evaluations")?,"decisions":counts("decisions")?,"artifacts":counts("artifacts")?,"nodes":counts("nodes")?,"edges":counts("edges")?},"watermark":seq}),
    )
}
pub(crate) fn run_page<S: SqlStore>(
    db: &S,
    cursor: Option<&str>,
    limit: usize,
    watermark: Option<i64>,
) -> Result<Value> {
    if !(1..=200).contains(&limit) {
        return Err(bad("Run page limit must be between 1 and 200"));
    }
    let after = cursor
        .map(|c| serde_json::from_str::<Value>(c).map_err(|_| bad("Invalid run cursor")))
        .transpose()?;
    let (after_created, after_id) = match after {
        Some(c) => (
            c["created_at"]
                .as_i64()
                .ok_or_else(|| bad("Invalid run cursor"))?,
            c["id"]
                .as_str()
                .ok_or_else(|| bad("Invalid run cursor"))?
                .to_owned(),
        ),
        None => (i64::MAX, "\u{10ffff}".to_owned()),
    };
    let high = checked_watermark(
        watermark.unwrap_or(
            db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events", &[])?[0]["seq"]
                .as_i64()
                .unwrap_or_default(),
        ),
    )?;
    let rows = db.query("SELECT h.run_id,h.seq,r.payload FROM run_history h JOIN runs r ON r.id=h.run_id WHERE h.seq<=? AND (h.created_at,h.run_id)<(?,?) ORDER BY h.created_at DESC,h.run_id DESC LIMIT ?", &[json!(high),json!(after_created),json!(after_id),json!((limit+1) as i64)])?;
    let has_more = rows.len() > limit;
    let mut items: Vec<Value> = Vec::with_capacity(limit.min(rows.len()));
    for row in rows.iter().take(limit) {
        items.push(
            serde_json::from_str::<Value>(
                row["payload"]
                    .as_str()
                    .ok_or_else(|| bad("Corrupt run payload"))?,
            )
            .map_err(|e| bad(&e.to_string()))?,
        );
    }
    let next = if has_more {
        items
            .last()
            .map(|r| json!({"created_at":r["created_at"],"id":r["id"]}).to_string())
    } else {
        None
    };
    Ok(json!({"items":items,"next_cursor":next,"watermark":high,"has_more":has_more}))
}
pub(crate) fn run_detail<S: SqlStore>(db: &S, id: &str) -> Result<Value> {
    let run = get(db, "runs", id)?;
    let scoped = |table: &str| -> Result<Vec<Value>> {
        let rows = db.query(
            &format!(
                "SELECT payload FROM {table} WHERE json_extract(payload,'$.run_id')=? ORDER BY id"
            ),
            &[json!(id)],
        )?;
        rows.iter()
            .map(|r| {
                serde_json::from_str(
                    r["payload"]
                        .as_str()
                        .ok_or_else(|| bad("Corrupt history payload"))?,
                )
                .map_err(|e| bad(&e.to_string()))
            })
            .collect()
    };
    let executions = scoped("executions")?;
    let mut candidates = scoped("candidates")?;
    for candidate in &mut candidates {
        if let Some(record) = candidate.as_object_mut() {
            record.remove("diff");
        }
    }
    let evaluations = run_evaluations(db, id)?;
    let decisions = scoped("decisions")?;
    let team_tasks = scoped("team_tasks")?;
    let team_handoffs = scoped("team_handoffs")?;
    let artifacts = run_artifacts(db, id)?;
    let archive = db.query(
        "SELECT payload FROM archive_index WHERE run_id=?",
        &[json!(id)],
    )?;
    let archive = archive
        .first()
        .map(|row| {
            serde_json::from_str::<Value>(row["payload"].as_str().unwrap_or_default())
                .map_err(|e| bad(&e.to_string()))
        })
        .transpose()?;
    Ok(
        json!({"v":1,"repository":repo(db)?,"run":run,"runs":[run],"executions":executions,"candidates":candidates,"evaluations":evaluations,"decisions":decisions,"team_tasks":team_tasks,"team_handoffs":team_handoffs,"artifacts":artifacts,"nodes":[],"edges":[],"graph_paged":true,"source_diffs":"digest_only","archive":archive}),
    )
}

fn run_evaluations<S: SqlStore>(db: &S, run_id: &str) -> Result<Vec<Value>> {
    let rows = db.query("SELECT e.payload FROM candidates c CROSS JOIN evaluations e INDEXED BY evaluations_by_candidate WHERE json_extract(c.payload,'$.run_id')=? AND json_extract(e.payload,'$.candidate')=c.id ORDER BY e.id", &[json!(run_id)])?;
    decode_payloads(rows)
}

fn run_artifacts<S: SqlStore>(db: &S, run_id: &str) -> Result<Vec<Value>> {
    let executions = db.query(
        "SELECT id FROM executions WHERE json_extract(payload,'$.run_id')=? ORDER BY id",
        &[json!(run_id)],
    )?;
    let execution_ids = executions
        .iter()
        .filter_map(|row| row["id"].as_str())
        .collect::<Vec<_>>();
    let mut selects =
        vec!["SELECT id FROM artifacts WHERE json_extract(payload,'$.run_id')=?".to_owned()];
    let mut params = vec![json!(run_id)];
    if !execution_ids.is_empty() {
        let slots = std::iter::repeat_n("?", execution_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        for path in [
            "$.producer",
            "$.producer.execution",
            "$.producer.execution.id",
        ] {
            selects.push(format!(
                "SELECT id FROM artifacts WHERE json_extract(payload,'{path}') IN ({slots})"
            ));
            params.extend(execution_ids.iter().map(|id| json!(id)));
        }
    }
    let sql = format!(
        "SELECT payload FROM artifacts WHERE id IN ({}) ORDER BY id",
        selects.join(" UNION ")
    );
    decode_payloads(db.query(&sql, &params)?)
}

fn decode_payloads(rows: Vec<Value>) -> Result<Vec<Value>> {
    rows.iter()
        .map(|row| {
            serde_json::from_str(
                row["payload"]
                    .as_str()
                    .ok_or_else(|| bad("Corrupt history payload"))?,
            )
            .map_err(|e| bad(&e.to_string()))
        })
        .collect()
}

pub(crate) fn run_graph_page<S: SqlStore>(
    db: &S,
    run_id: &str,
    cursor: Option<&str>,
    limit: usize,
    watermark: Option<i64>,
) -> Result<Value> {
    if !(1..=200).contains(&limit) {
        return Err(bad("Graph page limit must be between 1 and 200"));
    }
    get(db, "runs", run_id)?;
    let after = cursor
        .map(|c| serde_json::from_str::<Value>(c).map_err(|_| bad("Invalid graph cursor")))
        .transpose()?
        .unwrap_or(json!({"source":"","target":"","relation":""}));
    let high = checked_watermark(
        watermark.unwrap_or(
            db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events", &[])?[0]["seq"]
                .as_i64()
                .unwrap_or_default(),
        ),
    )?;
    let mut anchors = vec![run_id.to_owned()];
    for table in [
        "executions",
        "candidates",
        "decisions",
        "team_tasks",
        "team_handoffs",
    ] {
        let rows = db.query(
            &format!("SELECT id FROM {table} WHERE json_extract(payload,'$.run_id')=?"),
            &[json!(run_id)],
        )?;
        anchors.extend(
            rows.iter()
                .filter_map(|r| r["id"].as_str().map(str::to_owned)),
        );
    }
    anchors.extend(
        run_evaluations(db, run_id)?
            .iter()
            .filter_map(|row| row["id"].as_str().map(str::to_owned)),
    );
    anchors.extend(
        run_artifacts(db, run_id)?
            .iter()
            .filter_map(|row| row["id"].as_str().map(str::to_owned)),
    );
    anchors.sort();
    anchors.dedup();
    let slots = std::iter::repeat_n("?", anchors.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT source,target,relation,evidence,seq FROM edge_history JOIN edges USING(source,target,relation) WHERE seq<=? AND ((source IN ({slots})) OR (target IN ({slots}))) AND (source,target,relation)>(?,?,?) ORDER BY source,target,relation LIMIT ?"
    );
    let mut params = vec![json!(high)];
    params.extend(anchors.iter().map(|v| json!(v)));
    params.extend(anchors.iter().map(|v| json!(v)));
    params.extend([
        after["source"].clone(),
        after["target"].clone(),
        after["relation"].clone(),
        json!((limit + 1) as i64),
    ]);
    let rows = db.query(&sql, &params)?;
    let has_more = rows.len() > limit;
    let selected = rows.into_iter().take(limit).collect::<Vec<_>>();
    let next = if has_more {
        selected.last().map(|e| {
            json!({"source":e["source"],"target":e["target"],"relation":e["relation"]}).to_string()
        })
    } else {
        None
    };
    let mut node_ids = std::collections::BTreeSet::from([run_id.to_owned()]);
    for edge in &selected {
        if let Some(id) = edge["source"].as_str() {
            node_ids.insert(id.to_owned());
        }
        if let Some(id) = edge["target"].as_str() {
            node_ids.insert(id.to_owned());
        }
    }
    let mut nodes = Vec::with_capacity(node_ids.len());
    for id in node_ids {
        if db
            .query("SELECT id FROM nodes WHERE id=?", &[json!(id)])?
            .is_empty()
        {
            continue;
        }
        nodes.push(get(db, "nodes", &id)?);
    }
    let edges = selected
        .into_iter()
        .map(|mut edge| {
            edge.as_object_mut().map(|o| o.remove("seq"));
            edge
        })
        .collect::<Vec<_>>();
    Ok(json!({"nodes":nodes,"edges":edges,"next_cursor":next,"watermark":high,"has_more":has_more}))
}
