use super::*;
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, state: &Value) -> Result<Value> {
    if let Some(expected) = c.get("expected_workspace_version")
        && expected != &state["workspace_version"]
    {
        return Err(Error::new(
            "VERSION_CONFLICT",
            "Source read version changed",
        ));
    }
    let op = string(c, "op")?;
    if op == "source_list" {
        return list(db, c, state);
    }
    let path = string(c, "path")?;
    let value = row(db, &path)?;
    let stat = stat(db, &path, &value, state)?;
    if op == "source_stat" {
        return Ok(stat);
    }
    check_file(db, &path, &c["expected_file_version"])?;
    if value["file"].is_null() {
        return Err(Error::new("NOT_FOUND", "Source file does not exist"));
    }
    let offset = c["offset"].as_u64().unwrap_or(0);
    let limit = c["limit"].as_u64().unwrap_or(65536);
    let size = value["file"]["size"]
        .as_u64()
        .ok_or_else(|| bad("Invalid source size"))?;
    if offset > size || !(1..=65536).contains(&limit) {
        return Err(bad("Invalid bounded source range"));
    }
    Ok(
        json!({"version":1,"workspace_id":state["binding"]["workspace_id"],"workspace_version":state["workspace_version"],"file":stat,"content":value["file"]["content"],"offset":offset,"length":limit.min(size-offset)}),
    )
}
fn stat<S: SqlStore>(db: &S, path: &str, row: &Value, state: &Value) -> Result<Value> {
    if !row["file"].is_null() {
        let file = &row["file"];
        return Ok(
            json!({"path":path,"kind":"file","exists":true,"file_version":row["file_version"],"mode":file["mode"],"size":file["size"],"content":file["content"]}),
        );
    }
    if files(db)?
        .keys()
        .any(|p| p.starts_with(&format!("{path}/")))
    {
        return Ok(
            json!({"path":path,"kind":"directory","exists":true,"file_version":state["workspace_version"]}),
        );
    }
    Ok(json!({"path":path,"kind":"missing","exists":false,"file_version":row["file_version"]}))
}
fn list<S: SqlStore>(db: &S, c: &Value, state: &Value) -> Result<Value> {
    let prefix = c["prefix"].as_str().unwrap_or("");
    let recursive = c["recursive"].as_bool().unwrap_or(false);
    if !prefix.is_empty() {
        yoneda_agents_core::validate_path(prefix.trim_end_matches('/'))?;
    }
    let limit = c["limit"].as_u64().unwrap_or(50);
    if !(1..=200).contains(&limit) {
        return Err(bad("Source list limit must be 1–200"));
    }
    let identity = yoneda_agents_core::fingerprint(
        &json!({"version":state["workspace_version"],"prefix":prefix,"recursive":recursive}),
    )?;
    let cursor = c["cursor"].as_str().unwrap_or("");
    let after = if cursor.is_empty() {
        String::new()
    } else {
        if cursor.len() > 1024 {
            return Err(bad("Source cursor exceeds bounds"));
        }
        let value: Value =
            serde_json::from_str(cursor).map_err(|_| bad("Invalid source cursor"))?;
        if value["identity"] != identity {
            return Err(Error::new(
                "VERSION_CONFLICT",
                "Source list cursor or view changed",
            ));
        }
        string(&value, "after")?
    };
    let mut items = std::collections::BTreeMap::new();
    for file in files(db)?
        .into_values()
        .filter(|f| f.path.starts_with(prefix))
    {
        let rest = &file.path[prefix.len()..];
        let path = if !recursive && rest.contains('/') {
            format!("{prefix}{}", rest.split('/').next().unwrap_or(""))
        } else {
            file.path.clone()
        };
        if path.as_str() <= after.as_str() {
            continue;
        }
        let value = if path != file.path {
            json!({"path":path,"kind":"directory","exists":true,"file_version":state["workspace_version"]})
        } else {
            stat(db, &path, &row(db, &path)?, state)?
        };
        items.insert(path, value);
    }
    let count = usize::try_from(limit).map_err(|_| bad("Invalid source limit"))?;
    let more = items.len() > count;
    let page = items.into_values().take(count).collect::<Vec<_>>();
    let cursor = if more {
        page.last()
            .map(|v| json!({"identity":identity,"after":v["path"]}).to_string())
    } else {
        None
    };
    Ok(
        json!({"version":1,"workspace_id":state["binding"]["workspace_id"],"workspace_version":state["workspace_version"],"items":page,"next_cursor":cursor,"authority":"staged_source"}),
    )
}
pub(super) fn events<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let after = c["after"].as_i64().unwrap_or(0);
    let limit = c["limit"].as_i64().unwrap_or(50);
    if after < 0 || !(1..=200).contains(&limit) {
        return Err(bad("Invalid source event page"));
    }
    let rows = db.query(
        "SELECT seq,payload FROM sw_events WHERE seq>? ORDER BY seq LIMIT ?",
        &[json!(after), json!(limit + 1)],
    )?;
    let more =
        rows.len() > usize::try_from(limit).map_err(|_| bad("Invalid source event limit"))?;
    let mut items = Vec::new();
    for row in rows
        .into_iter()
        .take(usize::try_from(limit).map_err(|_| bad("Invalid limit"))?)
    {
        let mut event: Value = serde_json::from_str(
            row["payload"]
                .as_str()
                .ok_or_else(|| bad("Corrupt source event"))?,
        )
        .map_err(|_| bad("Corrupt source event"))?;
        event["seq"] = row["seq"].clone();
        items.push(event);
    }
    Ok(
        json!({"items":items,"next_cursor":items.last().map(|v|v["seq"].clone()).unwrap_or(json!(after)),"has_more":more}),
    )
}
