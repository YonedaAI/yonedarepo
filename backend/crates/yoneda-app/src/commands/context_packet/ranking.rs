use crate::storage::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_agents_core::Result;

#[derive(Clone, Copy)]
pub(super) struct Selection<'a> {
    pub query: &'a str,
    pub file: Option<&'a str>,
    pub authority: Option<&'a str>,
    pub lineage: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub watermark: i64,
    pub records: Option<&'a [Value]>,
}
pub(super) fn ranked<S: SqlStore>(
    db: &S,
    selection: &Selection<'_>,
    limit: usize,
) -> Result<Vec<Value>> {
    let Selection {
        query,
        file,
        authority,
        lineage,
        watermark,
        kind,
        records,
    } = *selection;
    if query.len() > 512 || !(1..=200).contains(&limit) {
        return Err(bad("Ranked context needs bounded query and limit"));
    }
    if let Some(path) = file {
        yoneda_agents_core::validate_path(path)?;
    }
    if authority.is_some_and(|v| {
        ![
            "assertion",
            "captured_revision",
            "checked_revision",
            "recorded_decision",
            "source_revision",
            "platform_record",
        ]
        .contains(&v)
    }) {
        return Err(bad("Unknown context authority"));
    }
    let terms: BTreeSet<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.len() > 3)
        .filter(|s| {
            ![
                "with",
                "from",
                "that",
                "this",
                "have",
                "build",
                "make",
                "implement",
                "please",
            ]
            .contains(s)
        })
        .take(32)
        .map(str::to_lowercase)
        .collect();
    // Preserve the previous working run's constraints even after unrelated history grows.
    let values = if let Some(records) = records {
        records.to_vec()
    } else {
        let rows=db.query("SELECT payload FROM nodes WHERE rowid<=? AND (? IS NULL OR json_extract(payload,'$.kind')=?) AND json_extract(payload,'$.kind') IN ('intent','requirement','constraint','assumption','finding','alternative','proposed_decision','question','decision','source') ORDER BY CASE WHEN id=? OR json_extract(payload,'$.data.run_id')=? OR json_extract(payload,'$.data.intent_id')=? THEN 0 ELSE 1 END,CAST(json_extract(payload,'$.recorded_at') AS INTEGER) DESC,id LIMIT 1001",&[json!(watermark),json!(kind),json!(kind),json!(lineage.map(|r|format!("intent:{r}"))),json!(lineage),json!(lineage.map(|r|format!("intent:{r}")))])?;
        rows.iter()
            .map(|row| {
                serde_json::from_str(
                    row["payload"]
                        .as_str()
                        .ok_or_else(|| bad("Corrupt context"))?,
                )
                .map_err(|e| bad(&e.to_string()))
            })
            .collect::<Result<Vec<Value>>>()?
    };
    let mut scored = Vec::new();
    for mut value in values.into_iter().take(1000) {
        if kind.is_some_and(|kind| value["kind"] != kind) {
            continue;
        }
        let id = string(&value, "id")?;
        let evidence = super::super::context_evidence::target(db, &id, None)?;
        if authority.is_some_and(|v| evidence["authority"] != v) {
            continue;
        }
        let paths = value["data"]["file_paths"].as_array();
        if file.is_some_and(|p| {
            !paths.is_some_and(|v| v.iter().any(|v| v == p)) && value["data"]["path"] != p
        }) {
            continue;
        }
        let related = lineage.is_some_and(|r| {
            id == format!("intent:{r}")
                || value["data"]["run_id"] == r
                || value["data"]["intent_id"] == format!("intent:{r}")
                || value["data"]["execution_id"]
                    .as_str()
                    .is_some_and(|e| e.starts_with(&format!("{r}:")))
        });
        let label = value["label"].as_str().unwrap_or("").to_lowercase();
        let statement = value["data"]["statement"]
            .as_str()
            .unwrap_or("")
            .to_lowercase();
        let purpose: String = value["data"]["purpose"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(2048)
            .flat_map(char::to_lowercase)
            .collect();
        let identifier: String = id.chars().take(256).flat_map(char::to_lowercase).collect();
        let matches = terms
            .iter()
            .filter(|t| {
                label.contains(t.as_str())
                    || statement.contains(t.as_str())
                    || purpose.contains(t.as_str())
                    || identifier.contains(t.as_str())
            })
            .count();
        if !query.is_empty() && matches == 0 && !related {
            continue;
        }
        let score = matches * 10
            + usize::from(related) * 100
            + usize::from(value["kind"] == "constraint" || value["kind"] == "requirement") * 20
            + usize::from(evidence["authority"] == "recorded_decision") * 30;
        value["retrieval"] =
            json!({"score":score,"lineage_match":related,"authority":evidence["authority"]});
        scored.push((
            score,
            value["recorded_at"].as_i64().unwrap_or_default(),
            id,
            value,
        ));
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    Ok(scored
        .into_iter()
        .take(limit)
        .map(|(_, _, _, v)| v)
        .collect())
}
