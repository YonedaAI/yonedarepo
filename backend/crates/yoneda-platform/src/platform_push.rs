//! Push batching for object stores that take one receive-pack per repository at a time
//! (Artifacts): the push queue combines waiting pushes and splits the report per ref.
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::Result;
use yoneda_core::git_object::{combine_receive_pack_requests, split_receive_pack_report};

pub fn push_combine(c: &Value) -> Result<Value> {
    let bodies = c["bodies_b64"]
        .as_array()
        .filter(|b| !b.is_empty())
        .ok_or_else(|| bad("bodies_b64 must be a non-empty array"))?
        .iter()
        .map(|b| {
            b.as_str()
                .and_then(|b| STANDARD.decode(b).ok())
                .ok_or_else(|| bad("bodies_b64 entries must be base64"))
        })
        .collect::<Result<Vec<_>>>()?;
    let slices: Vec<&[u8]> = bodies.iter().map(Vec::as_slice).collect();
    let (body, refs) = combine_receive_pack_requests(&slices)?;
    Ok(json!({ "push_b64": STANDARD.encode(body), "refs": refs }))
}

pub fn push_split(c: &Value) -> Result<Value> {
    let report = STANDARD
        .decode(string(c, "report_b64")?)
        .map_err(|_| bad("report_b64 is not base64"))?;
    let split = split_receive_pack_report(&report, &string(c, "refname")?)?;
    Ok(json!({ "report_b64": STANDARD.encode(split) }))
}
