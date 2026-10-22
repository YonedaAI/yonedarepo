//! Read-only staged delta for resuming an interrupted attempt. An attempt that timed out never
//! checkpoints; its committed writes remain here and the next attempt of the same job may copy
//! them. Supervisor purpose only; read-only grants suffice, so nothing here can mutate source.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn changes<S: SqlStore>(
    db: &S,
    c: &Value,
    state: &Value,
    actor: &ActorGrant,
) -> Result<Value> {
    if actor.claims.purpose != ActorPurpose::Supervisor {
        return Err(Error::new(
            "FORBIDDEN",
            "Staged source deltas are supervisor-only",
        ));
    }
    let after = c["after"].as_str().unwrap_or("");
    if !after.is_empty() {
        yoneda_agents_core::validate_path(after)?;
    }
    let limit = c["limit"].as_u64().unwrap_or(100);
    if !(1..=200).contains(&limit) {
        return Err(bad("Staged delta page limit must be 1–200"));
    }
    let limit = usize::try_from(limit).map_err(|_| bad("Invalid staged delta limit"))?;
    let current = files(db)?;
    let baseline = rows::bounded(db, "sw_baseline", MAX_FILES)?
        .into_iter()
        .map(|v| {
            let f: SourceFile = decode(&v)?;
            Ok((f.path.clone(), f))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    let paths = baseline
        .keys()
        .chain(current.keys())
        .filter(|path| path.as_str() > after)
        .collect::<BTreeSet<_>>();
    let mut items = Vec::new();
    let mut more = false;
    for path in paths {
        let (before, now) = (baseline.get(path), current.get(path));
        if before == now {
            continue;
        }
        if items.len() == limit {
            more = true;
            break;
        }
        items.push(json!({"path":path,"after":now}));
    }
    Ok(
        json!({"version":1,"workspace_id":state["binding"]["workspace_id"],
        "workspace_version":state["workspace_version"],"items":items,
        "next_cursor":if more {items.last().map(|item| item["path"].clone())} else {None},
        "has_more":more,"authority":"staged_source"}),
    )
}
