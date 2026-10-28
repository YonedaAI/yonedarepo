//! The graph nodes a run owns, and the removal of every row keyed to it.
use super::{Owned, ids, list};
use crate::storage::*;
use serde_json::json;
use yoneda_agents_core::Result;

/// Graph nodes the run owns: its records and receipts, the assumptions its artifacts state,
/// owner observations of those assumptions, and source anchors only its decisions selected.
pub(super) fn node_ids<S: SqlStore>(db: &S, id: &str, owned: &Owned) -> Result<Vec<String>> {
    let mut nodes = vec![id.to_owned(), format!("intent:{id}")];
    for records in [
        &owned.executions,
        &owned.candidates,
        &owned.evaluations,
        &owned.decisions,
        &owned.artifacts,
        &owned.team_handoffs,
    ] {
        nodes.extend(records.iter().cloned());
    }
    nodes.extend(
        owned
            .team_tasks
            .iter()
            .map(|task| format!("team-task:{task}")),
    );
    // File provenance receipts and other projections carry the run in their data.
    nodes.extend(ids(
        db,
        "SELECT id FROM nodes WHERE json_extract(payload,'$.data.run_id')=?",
        &[json!(id)],
    )?);
    let assumptions = ids(
        db,
        "SELECT target AS id FROM edges WHERE relation='states' AND source IN (SELECT value FROM json_each(?))",
        &[list(&owned.artifacts)],
    )?;
    nodes.extend(ids(
        db,
        "SELECT source AS id FROM edges WHERE relation='challenges' AND target IN (SELECT value FROM json_each(?))",
        &[list(&assumptions)],
    )?);
    nodes.extend(assumptions);
    let decisions = list(&owned.decisions);
    nodes.extend(ids(
        db,
        "SELECT DISTINCT e.target AS id FROM edges e WHERE e.relation='selected_as' AND e.source IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM edges o WHERE o.target=e.target AND o.relation='selected_as' AND o.source NOT IN (SELECT value FROM json_each(?)))",
        &[decisions.clone(), decisions],
    )?);
    nodes.sort();
    nodes.dedup();
    Ok(nodes)
}

pub(super) fn purge<S: SqlStore>(db: &S, id: &str, owned: &Owned, nodes: &[String]) -> Result<()> {
    let run = json!(id);
    let graph = list(nodes);
    for table in ["edges", "edge_history"] {
        db.query(
            &format!("DELETE FROM {table} WHERE source IN (SELECT value FROM json_each(?)) OR target IN (SELECT value FROM json_each(?))"),
            &[graph.clone(), graph.clone()],
        )?;
    }
    db.query(
        "DELETE FROM nodes WHERE id IN (SELECT value FROM json_each(?))",
        std::slice::from_ref(&graph),
    )?;
    let executions = list(&owned.executions);
    let mut records = nodes.to_vec();
    records.extend(owned.jobs.iter().cloned());
    let records = list(&records);
    // Lifecycle events name the run, or one of its records, under these keys.
    let keyed = [
        "$.id",
        "$.execution",
        "$.execution_id",
        "$.candidate",
        "$.candidate_id",
        "$.decision_id",
        "$.job_id",
    ]
    .map(|path| format!("json_extract(data,'{path}') IN (SELECT value FROM json_each(?))"))
    .join(" OR ");
    let mut params = vec![run.clone(), run.clone()];
    params.extend(std::iter::repeat_n(records, 7));
    let removed = db.query(&format!("DELETE FROM events WHERE json_extract(data,'$.run_id')=? OR json_extract(data,'$.reservation.run_id')=? OR {keyed} RETURNING seq"), &params)?;
    let seqs = json!(
        json!(
            removed
                .iter()
                .map(|row| row["seq"].clone())
                .collect::<Vec<_>>()
        )
        .to_string()
    );
    // Delivered notifications keep a copy of each event until pruning; drop those copies now.
    db.query("UPDATE outbox SET payload='{}',payload_pruned=1 WHERE delivered=1 AND id IN (SELECT 'live:'||value FROM json_each(?) UNION SELECT 'index:'||value FROM json_each(?))", &[seqs.clone(), seqs])?;
    // Delivered dispatches and stops of the deleted jobs; undelivered stops still go out.
    db.query("DELETE FROM outbox WHERE delivered=1 AND json_extract(payload,'$.job_id') IN (SELECT value FROM json_each(?))", &[list(&owned.jobs)])?;
    for (table, rows) in [
        ("executions", &owned.executions),
        ("candidates", &owned.candidates),
        ("evaluations", &owned.evaluations),
        ("decisions", &owned.decisions),
        ("artifacts", &owned.artifacts),
        ("jobs", &owned.jobs),
        ("team_tasks", &owned.team_tasks),
        ("team_handoffs", &owned.team_handoffs),
    ] {
        db.query(
            &format!("DELETE FROM {table} WHERE id IN (SELECT value FROM json_each(?))"),
            &[list(rows)],
        )?;
    }
    for table in [
        "model_reservations",
        "context_sessions",
        "intent_questions",
        "archive_jobs",
    ] {
        db.query(
            &format!("DELETE FROM {table} WHERE json_extract(payload,'$.run_id')=?"),
            std::slice::from_ref(&run),
        )?;
    }
    db.query("DELETE FROM peer_deliveries WHERE message_seq IN (SELECT seq FROM peer_messages WHERE run_id=?) OR execution_id IN (SELECT value FROM json_each(?))", &[run.clone(), executions.clone()])?;
    db.query("DELETE FROM context_access WHERE run_id=? OR execution_id IN (SELECT value FROM json_each(?))", &[run.clone(), executions.clone()])?;
    db.query(
        "DELETE FROM execution_logs WHERE execution_id IN (SELECT value FROM json_each(?))",
        &[executions],
    )?;
    db.query(
        "DELETE FROM conflicts WHERE json_extract(payload,'$.candidate_id') IN (SELECT value FROM json_each(?))",
        &[list(&owned.candidates)],
    )?;
    for table in ["peer_messages", "run_history", "archive_index"] {
        db.query(
            &format!("DELETE FROM {table} WHERE run_id=?"),
            std::slice::from_ref(&run),
        )?;
    }
    db.query("DELETE FROM runs WHERE id=?", &[run])?;
    Ok(())
}
