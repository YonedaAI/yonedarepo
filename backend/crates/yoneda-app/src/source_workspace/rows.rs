use super::*;
pub(super) fn payload(row: &Value) -> Result<Value> {
    serde_json::from_str(
        row["payload"]
            .as_str()
            .ok_or_else(|| bad("Corrupt source row"))?,
    )
    .map_err(|_| bad("Corrupt source row"))
}
/// Separate from repository query helpers: never silently truncates source metadata.
pub(super) fn bounded<S: SqlStore>(db: &S, table: &str, max: usize) -> Result<Vec<Value>> {
    if !["sw_files", "sw_baseline", "sw_view_files", "sw_overrides"].contains(&table) {
        return Err(bad("Invalid source metadata table"));
    }
    let count = db.query(&format!("SELECT COUNT(*) AS count FROM {table}"), &[])?;
    let count = count
        .first()
        .and_then(|v| v["count"].as_u64())
        .ok_or_else(|| bad("Invalid source row count"))?;
    if count > u64::try_from(max).map_err(|_| bad("Invalid source row bound"))? {
        return Err(Error::new(
            "SOURCE_LIMIT",
            "Source metadata exceeds documented bound",
        ));
    }
    let mut output = Vec::new();
    let mut after = String::new();
    loop {
        let page = db.query(
            &format!("SELECT id,payload FROM {table} WHERE id>? ORDER BY id LIMIT 200"),
            &[json!(after)],
        )?;
        if page.is_empty() {
            break;
        }
        for row in page {
            after = string(&row, "id")?;
            output.push(payload(&row)?);
        }
        if output.len() > max {
            return Err(Error::new("SOURCE_LIMIT", "Source row bound changed"));
        }
    }
    Ok(output)
}
