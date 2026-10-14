//! Evaluators receive policy-sized integrity evidence, never the full path manifest.
use super::*;
pub(crate) fn fields<S: SqlStore>(db: &S, candidate: &Value, policy: &Value) -> Result<Value> {
    let paths = load(db, candidate, "paths")?;
    let reference = candidate
        .get("paths_ref")
        .filter(|v| !v.is_null())
        .ok_or_else(|| bad("API evaluation requires frozen path reference"))?;
    let protected = policy["build"]["test_bundle"]["protected_paths"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut changed = std::collections::BTreeSet::new();
    for prefix in protected {
        let p = prefix
            .as_str()
            .ok_or_else(|| bad("Invalid protected prefix"))?;
        let root = p.trim_end_matches('/');
        if paths.iter().any(|path| {
            path == root
                || path.starts_with(&format!("{root}/"))
                || root.starts_with(&format!("{path}/"))
        }) {
            changed.insert(p.to_owned());
        }
    }
    Ok(
        json!({"version":1,"candidate_id":candidate["id"],"revision":candidate["revision"],"paths_digest":reference["digest"],"protected_changes":changed,"policy_digest":yoneda_core::fingerprint(policy)?}),
    )
}
pub(crate) fn validate<S: SqlStore>(db: &S, job: &Value, candidate: &Value) -> Result<()> {
    if job["payload"]["source_integrity"] != fields(db, candidate, &job["payload"]["policy"])? {
        return Err(Error::new(
            "FENCED",
            "API evaluation path or policy integrity changed",
        ));
    }
    Ok(())
}
