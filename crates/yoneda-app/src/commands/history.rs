use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "why" => {
            let path = string(&c, "path")?;
            yoneda_core::validate_path(&path)?;
            let commit = hash(&c, "commit", &[40, 64])?;
            let id = format!("source:{commit}:{path}");
            if get(db, "nodes", &id).is_err() {
                return Ok(json!({"coverage":"unknown","nodes":[],"edges":[]}));
            }
            neighborhood(db, &id, c["depth"].as_u64().unwrap_or(7).min(8) as usize)
        }
        "graph" => neighborhood(
            db,
            &string(&c, "id")?,
            c["depth"].as_u64().unwrap_or(4).min(8) as usize,
        ),
        "observe" => {
            let id = string(&c, "id")?;
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
use std::collections::{BTreeSet, VecDeque};
fn neighborhood<S: SqlStore>(db: &S, id: &str, depth: usize) -> Result<Value> {
    get(db, "nodes", id)?;
    let nodes = all(db, "nodes")?;
    let edges = db.query(
        "SELECT source,target,relation,evidence FROM edges LIMIT 4000",
        &[],
    )?;
    let mut seen = BTreeSet::new();
    let mut queue = VecDeque::from([(id.to_owned(), 0)]);
    while let Some((id, d)) = queue.pop_front() {
        if seen.len() >= 500 || !seen.insert(id.clone()) || d >= depth {
            continue;
        }
        for e in &edges {
            let source = e["source"].as_str().unwrap_or_default();
            let target = e["target"].as_str().unwrap_or_default();
            if source == id {
                queue.push_back((target.into(), d + 1));
            } else if target == id {
                queue.push_back((source.into(), d + 1));
            }
        }
    }
    Ok(
        json!({"coverage":"recorded","nodes":nodes.into_iter().filter(|n|seen.contains(n["id"].as_str().unwrap_or_default())).collect::<Vec<_>>(),"edges":edges.into_iter().filter(|e|seen.contains(e["source"].as_str().unwrap_or_default())&&seen.contains(e["target"].as_str().unwrap_or_default())).collect::<Vec<_>>(),"bounded":true}),
    )
}
