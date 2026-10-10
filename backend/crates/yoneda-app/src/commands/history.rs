use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

#[path = "provenance.rs"]
pub(super) mod provenance;
#[allow(unused_imports)] // Lead integration hooks called from capture_completion and accept.
pub(super) use provenance::capture_file_provenance;
#[allow(unused_imports)]
pub(super) use provenance::link_file_provenance_to_decision;
#[allow(unused_imports)]
pub(super) use provenance::link_file_provenance_to_publication;

pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "why" => {
            let path = string(&c, "path")?;
            yoneda_core::validate_path(&path)?;
            let commit = hash(&c, "commit", &[40, 64])?;
            provenance::why(db, &commit, &path)
        }
        "graph" => neighborhood(
            db,
            &string(&c, "id")?,
            c["depth"].as_u64().unwrap_or(4).min(8) as usize,
        ),
        "observe" => {
            let id = string(&c, "id")?;
            if !db
                .query("SELECT id FROM nodes WHERE id=?", &[json!(id)])?
                .is_empty()
            {
                return Err(Error::new(
                    "ALREADY_EXISTS",
                    "Observation IDs are append-only",
                ));
            }
            let assumption = string(&c, "assumption")?;
            let a = get(db, "nodes", &assumption)?;
            if a["kind"] != "assumption" {
                return Err(bad("Observation target must be an assumption"));
            }
            let metric = string(&c, "metric")?;
            if a["data"]["metric"] != metric {
                return Err(bad("Observation metric does not match assumption"));
            }
            let value = number(&c, "value")?;
            let limit = number(&a["data"], "limit")?;
            let observation = json!({"metric":metric,"value":value,"limit":limit,"simulated":c["simulated"]==true,"status":if value>limit {"exceeded"}else{"within_bound"}});
            node(
                db,
                &id,
                "observation",
                &format!("{metric}: {value}"),
                "owner_observation",
                now,
                observation.clone(),
            )?;
            edge(db, &id, &assumption, "challenges", "explicit observation")?;
            event(
                db,
                "assumption.observed",
                now,
                json!({"id":id,"assumption":assumption,"observation":observation}),
            )?;
            Ok(observation)
        }
        "decision" => get(db, "decisions", &string(&c, "id")?),
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
}

fn neighborhood<S: SqlStore>(db: &S, id: &str, depth: usize) -> Result<Value> {
    get(db, "nodes", id)?;
    let mut discovered = std::collections::BTreeSet::from([id.to_owned()]);
    let mut queue = std::collections::VecDeque::from([(id.to_owned(), 0)]);
    let mut nodes = Vec::new();
    let mut edges = std::collections::BTreeMap::new();
    let mut truncated = false;
    while let Some((id, d)) = queue.pop_front() {
        nodes.push(get(db, "nodes", &id)?);
        if edges.len() >= 4000 {
            truncated = true;
            continue;
        }
        let adjacent = db.query("SELECT source,target,relation,evidence FROM edges WHERE source=? OR target=? ORDER BY source,target,relation LIMIT 501", &[json!(id),json!(id)])?;
        if adjacent.len() > 500 {
            truncated = true;
        }
        for edge in adjacent.into_iter().take(500) {
            if edges.len() >= 4000 {
                truncated = true;
                break;
            }
            let source = string(&edge, "source")?;
            let target = string(&edge, "target")?;
            let other = if source == id {
                target.clone()
            } else {
                source.clone()
            };
            if !discovered.contains(&other) {
                if d >= depth || discovered.len() >= 500 {
                    truncated = true;
                    continue;
                }
                discovered.insert(other.clone());
                queue.push_back((other, d + 1));
            }
            edges.insert((source, target, string(&edge, "relation")?), edge);
        }
    }
    let edges: Vec<_> = edges
        .into_values()
        .filter(|e| {
            discovered.contains(e["source"].as_str().unwrap_or_default())
                && discovered.contains(e["target"].as_str().unwrap_or_default())
        })
        .collect();
    Ok(
        json!({"coverage":"recorded","nodes":nodes,"edges":edges,"bounded":true,"truncated":truncated}),
    )
}
