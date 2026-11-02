//! Receive-pack bodies and reports for the object store: ref-only updates, hidden-ref
//! releases, and the R2 store's side of a push.
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::Result;

/// The report-status an object store answers with (R2 store).
pub(super) fn push_report(c: &Value) -> Result<Value> {
    let refname = string(c, "refname")?;
    let report = yoneda_core::transport::receive_pack_report(&refname, c["refused"].as_str());
    Ok(json!({ "report_b64": STANDARD.encode(report) }))
}

pub(super) fn push_outcome(c: &Value) -> Result<Value> {
    let report = STANDARD
        .decode(string(c, "report_b64")?)
        .map_err(|_| bad("report_b64 is not base64"))?;
    let refused = yoneda_core::transport::receive_pack_outcome(&report, &string(c, "refname")?)?;
    Ok(json!({ "accepted": refused.is_none(), "refused": refused }))
}
