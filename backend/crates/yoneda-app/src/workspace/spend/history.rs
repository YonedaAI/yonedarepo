//! Stable legacy reservation IDs reconcile overlaps; missing attribution remains charged.
use super::*;
use std::collections::BTreeMap;

fn reconciliation() -> Error {
    Error::new(
        "WORKSPACE_SPEND_RECONCILIATION_REQUIRED",
        "Historical reservation identities or totals need an owner audit",
    )
}
pub(super) fn totals<S: SqlStore>(db: &S) -> Result<(i64, i64)> {
    let rows=db.query("SELECT id,payload FROM workspace_records WHERE id='budget' OR id LIKE 'reservation:%' OR id LIKE 'campaign:%' OR id LIKE 'campaign-reservation:%' ORDER BY id",&[])?;
    let mut sources = BTreeMap::<String, (i64, i64)>::new();
    let mut identities = BTreeMap::<String, Vec<(i64, bool)>>::new();
    for row in &rows {
        let id = string(row, "id")?;
        let value: Value =
            serde_json::from_str(row["payload"].as_str().ok_or_else(reconciliation)?)
                .map_err(|_| reconciliation())?;
        if id == "budget" {
            sources.entry("legacy".into()).or_default().0 = money(&value, "charged")?;
        } else if id.starts_with("campaign:")
            && value["id"]
                .as_str()
                .is_some_and(|v| id == format!("campaign:{v}"))
        {
            sources.entry(id).or_default().0 = money(&value, "charged_microusd")?;
        }
    }
    for row in rows {
        let id = string(&row, "id")?;
        let value: Value =
            serde_json::from_str(row["payload"].as_str().ok_or_else(reconciliation)?)
                .map_err(|_| reconciliation())?;
        let reservation = if let Some(id) = id.strip_prefix("reservation:") {
            Some((
                id.to_owned(),
                "legacy".to_owned(),
                money(&value, "charged")?,
            ))
        } else if let Some(id) = id.strip_prefix("campaign-reservation:") {
            Some((
                id.to_owned(),
                format!("campaign:{}", string(&value["identity"]["binding"], "id")?),
                money(&value, "charged_microusd")?,
            ))
        } else {
            None
        };
        if let Some((identity, source, amount)) = reservation {
            let counter = sources.get_mut(&source).ok_or_else(reconciliation)?;
            counter.1 = add(counter.1, amount)?;
            let pending = match value["status"].as_str() {
                Some("reserved") => true,
                Some("settled") => false,
                _ => return Err(reconciliation()),
            };
            identities
                .entry(identity)
                .or_default()
                .push((amount, pending));
        }
    }
    let mut total = 0;
    for (counter, attributed) in sources.values() {
        if attributed > counter {
            return Err(reconciliation());
        }
        total = add(total, *counter)?;
    }
    let mut reserved = 0;
    for (id, entries) in identities {
        if entries.len() > 1
            && (id.len() != 64
                || !id
                    .bytes()
                    .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)))
        {
            return Err(reconciliation());
        }
        let max = entries.iter().map(|e| e.0).max().unwrap_or_default();
        let mut sum = 0;
        for e in &entries {
            sum = add(sum, e.0)?;
        }
        total = total
            .checked_sub(sum - max)
            .filter(|v| *v >= 0)
            .ok_or_else(reconciliation)?;
        if entries.iter().any(|e| e.1) {
            reserved = add(reserved, max)?;
        }
    }
    Ok((
        total
            .checked_sub(reserved)
            .filter(|v| *v >= 0)
            .ok_or_else(reconciliation)?,
        reserved,
    ))
}
