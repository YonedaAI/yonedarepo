use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub trait SqlStore: Clone + 'static {
    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Value>>;
    fn transaction(&self, action: Box<dyn FnOnce() -> Result<Value>>) -> Result<Value>;
}

pub fn migrate<S: SqlStore>(store: &S) -> Result<()> {
    const SCHEMA_VERSION: i64 = 4;
    store.query("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",&[])?;
    let owned = store.clone();
    store.transaction(Box::new(move || {
        let migrations = [
            (1, include_str!("migrations/0001_ledger.sql")),
            (2, include_str!("migrations/0002_run_index.sql")),
            (3, include_str!("migrations/0003_execution_graph.sql")),
            (4, include_str!("migrations/0004_state_graph.sql")),
        ];
        let applied = owned.query(
            "SELECT version,digest FROM schema_migrations ORDER BY version",
            &[],
        )?;
        if applied
            .iter()
            .any(|v| v["version"].as_i64().unwrap_or_default() > SCHEMA_VERSION)
        {
            return Err(Error::new(
                "SCHEMA_TOO_NEW",
                "Database schema requires a newer binary",
            ));
        }
        for (version, sql) in migrations {
            let digest = yoneda_core::digest(sql.as_bytes());
            if let Some(existing) = applied.iter().find(|v| v["version"] == version) {
                if existing["digest"] != digest {
                    return Err(Error::new(
                        "MIGRATION_DRIFT",
                        "An applied migration differs from the committed migration",
                    ));
                }
                continue;
            }
            for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
                owned.query(statement, &[])?;
            }
            owned.query(
                "INSERT INTO schema_migrations(version,digest) VALUES(?,?)",
                &[json!(version), json!(digest)],
            )?;
        }
        Ok(json!({"version":SCHEMA_VERSION}))
    }))?;
    Ok(())
}

pub(crate) fn bad(message: &str) -> Error {
    Error::new("INVALID_INPUT", message)
}
pub(crate) fn string(v: &Value, key: &str) -> Result<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 16384)
        .map(str::to_owned)
        .ok_or_else(|| bad(&format!("Missing or invalid {key}")))
}
pub(crate) fn number(v: &Value, key: &str) -> Result<i64> {
    v.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| bad(&format!("Missing or invalid {key}")))
}
pub(crate) fn hash(v: &Value, key: &str, lengths: &[usize]) -> Result<String> {
    let s = string(v, key)?;
    if !lengths.contains(&s.len()) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad(&format!("Invalid {key} digest")));
    }
    Ok(s)
}
pub(crate) fn get<S: SqlStore>(db: &S, table: &str, id: &str) -> Result<Value> {
    let rows = db.query(
        &format!("SELECT payload FROM {table} WHERE id=?"),
        &[json!(id)],
    )?;
    let row = rows
        .first()
        .ok_or_else(|| Error::new("NOT_FOUND", format!("Unknown {table} {id}")))?;
    serde_json::from_str(
        row["payload"]
            .as_str()
            .ok_or_else(|| bad("Corrupt payload"))?,
    )
    .map_err(|e| Error::new("DATABASE", e.to_string()))
}
pub(crate) fn all<S: SqlStore>(db: &S, table: &str) -> Result<Vec<Value>> {
    db.query(
        &format!("SELECT payload FROM {table} ORDER BY id LIMIT 2000"),
        &[],
    )?
    .iter()
    .map(|r| {
        serde_json::from_str(
            r["payload"]
                .as_str()
                .ok_or_else(|| bad("Corrupt payload"))?,
        )
        .map_err(|e| Error::new("DATABASE", e.to_string()))
    })
    .collect()
}
pub(crate) fn save<S: SqlStore>(db: &S, table: &str, id: &str, value: &Value) -> Result<()> {
    db.query(&format!("INSERT INTO {table}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload"),&[json!(id),json!(value.to_string())])?;
    let kind = match table {
        "runs" => Some("run"),
        "executions" => Some("execution"),
        "candidates" => Some("candidate"),
        _ => None,
    };
    if let Some(kind) = kind {
        db.query("UPDATE nodes SET payload=json_set(payload,'$.data',json(?)) WHERE id=? AND json_extract(payload,'$.kind')=?", &[json!(value.to_string()),json!(id),json!(kind)])?;
    }
    Ok(())
}
pub(crate) fn create<S: SqlStore>(db: &S, table: &str, id: &str, value: &Value) -> Result<()> {
    if get(db, table, id).is_ok() {
        return Err(Error::new(
            "ALREADY_EXISTS",
            format!("{table} {id} already exists"),
        ));
    }
    save(db, table, id, value)
}
pub(crate) fn repo<S: SqlStore>(db: &S) -> Result<Value> {
    get(db, "repository", "repo")
}
pub(crate) fn node<S: SqlStore>(
    db: &S,
    id: &str,
    kind: &str,
    label: &str,
    author: &str,
    now: i64,
    data: Value,
) -> Result<()> {
    save(
        db,
        "nodes",
        id,
        &json!({"id":id,"kind":kind,"label":label,"author":author,"recorded_at":now,"data":data}),
    )
}
/// Update the execution and its graph projection in the caller's transaction.
pub(crate) fn save_execution<S: SqlStore>(db: &S, execution: &Value, _now: i64) -> Result<()> {
    let id = string(execution, "id")?;
    save(db, "executions", &id, execution)
}
pub(crate) fn edge<S: SqlStore>(
    db: &S,
    source: &str,
    target: &str,
    relation: &str,
    evidence: &str,
) -> Result<()> {
    db.query(
        "INSERT OR IGNORE INTO edges(source,target,relation,evidence) VALUES(?,?,?,?)",
        &[
            json!(source),
            json!(target),
            json!(relation),
            json!(evidence),
        ],
    )?;
    Ok(())
}
pub(crate) fn outbox<S: SqlStore>(db: &S, id: &str, kind: &str, payload: Value) -> Result<()> {
    db.query(
        "INSERT OR IGNORE INTO outbox(id,kind,payload) VALUES(?,?,?)",
        &[json!(id), json!(kind), json!(payload.to_string())],
    )?;
    Ok(())
}
pub(crate) fn event<S: SqlStore>(db: &S, kind: &str, now: i64, data: Value) -> Result<()> {
    let rows = db.query(
        "INSERT INTO events(kind,at,data) VALUES(?,?,?) RETURNING seq",
        &[json!(kind), json!(now), json!(data.to_string())],
    )?;
    let seq = rows[0]["seq"]
        .as_i64()
        .ok_or_else(|| bad("Event sequence missing"))?;
    let r = repo(db)?;
    let payload = json!({"repo_id":r["id"],"seq":seq,"event":{"seq":seq,"kind":kind,"at":now,"data":data},"repository":r});
    outbox(db, &format!("live:{seq}"), "live", payload.clone())?;
    outbox(db, &format!("index:{seq}"), "index", payload)?;
    Ok(())
}
pub(crate) fn job<S: SqlStore>(
    db: &S,
    id: &str,
    kind: &str,
    now: i64,
    payload: Value,
) -> Result<()> {
    create(
        db,
        "jobs",
        id,
        &json!({"id":id,"kind":kind,"status":"queued","attempt":0,"epoch":0,"lease_until":0,"deadline":now+1_200_000,"payload":payload}),
    )?;
    outbox(db, &format!("dispatch:{id}:0"), kind, json!({"job_id":id}))
}
pub(crate) fn execution<S: SqlStore>(
    db: &S,
    run: &Value,
    harness: &str,
    strategy: &str,
    role: &str,
    context: Value,
    now: i64,
) -> Result<()> {
    let run_id = string(run, "id")?;
    let suffix = if role == "research" {
        "research".to_owned()
    } else {
        format!("{harness}-{strategy}")
    };
    let id = format!("{run_id}:{suffix}");
    let e = json!({"id":id,"run_id":run_id,"harness":harness,"strategy":strategy,"role":role,"status":"queued","context":context,"base":run["base"]});
    create(db, "executions", &id, &e)?;
    node(
        db,
        &id,
        "execution",
        &format!("{harness} / {strategy}"),
        "platform",
        now,
        e.clone(),
    )?;
    edge(db, &run_id, &id, "depends_on", "schedule")?;
    for artifact in context
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        edge(db, artifact, &id, "provided_to", "frozen execution context")?;
    }
    job(
        db,
        &format!("job:{id}"),
        "agent",
        now,
        json!({"execution":e,"run":run,"policy":repo(db)?["policy"]}),
    )
}
pub(crate) fn active<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let id = string(c, "job_id")?;
    let j = get(db, "jobs", &id)?;
    if c.get("_grant").is_some()
        && (j["external_grant"] != c["_grant"] || j["external_phase"] != "working")
    {
        return Err(Error::new(
            "FENCED",
            "External attempt identity or write phase changed",
        ));
    }
    if j["status"] != "running"
        || number(&j, "epoch")? != number(c, "epoch")?
        || number(&j, "lease_until")? <= now
        || number(&j, "attempt_deadline")? <= now
    {
        return Err(Error::new(
            "FENCED",
            "Attempt expired, was cancelled, or has been superseded",
        ));
    }
    Ok(j)
}
