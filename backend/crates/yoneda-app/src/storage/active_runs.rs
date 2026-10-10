use super::SqlStore;
use yoneda_core::Result;

pub(crate) fn active_run_count<S: SqlStore>(db: &S) -> Result<i64> {
    active_run_count_where(db, false)
}

pub(crate) fn external_run_count<S: SqlStore>(db: &S) -> Result<i64> {
    active_run_count_where(db, true)
}

fn active_run_count_where<S: SqlStore>(db: &S, external_only: bool) -> Result<i64> {
    let external_filter = if external_only {
        " AND json_extract(r.payload,'$.external')=1"
    } else {
        ""
    };
    let sql = format!(
        "WITH active_run_ids(run_id) AS (\
            SELECT json_extract(payload,'$.payload.execution.run_id') FROM jobs WHERE json_extract(payload,'$.status') IN ('queued','running') \
            UNION SELECT json_extract(payload,'$.payload.run_id') FROM jobs WHERE json_extract(payload,'$.status') IN ('queued','running') \
            UNION SELECT json_extract(payload,'$.payload.candidate.run_id') FROM jobs WHERE json_extract(payload,'$.status') IN ('queued','running') \
            UNION SELECT json_extract(d.payload,'$.run_id') FROM jobs j JOIN decisions d ON d.id=json_extract(j.payload,'$.payload.decision_id') WHERE json_extract(j.payload,'$.status') IN ('queued','running') \
            UNION SELECT json_extract(payload,'$.run_id') FROM executions WHERE json_extract(payload,'$.harness')='external' AND json_extract(payload,'$.status')='running'\
        ) SELECT COUNT(DISTINCT r.id) AS count FROM active_run_ids a JOIN runs r ON r.id=a.run_id WHERE a.run_id IS NOT NULL{external_filter}"
    );
    Ok(db.query(&sql, &[])?[0]["count"]
        .as_i64()
        .unwrap_or_default())
}
