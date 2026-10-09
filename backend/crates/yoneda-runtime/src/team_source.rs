//! Source SDK access stays in the Worker; assembly and write-scope decisions stay in Rust.
use crate::{broker::broker, team_workspace::Assembly};
use serde_json::{Value, json};
use yoneda_core::{Result, Workspace};

pub(crate) async fn load(job: &Value) -> Result<Workspace> {
    let result = broker("/source", json!({}), true).await?;
    let base: Workspace = serde_json::from_value(result["files"].clone()).map_err(crate::err)?;
    let Some(inputs) = job["payload"].get("team_inputs") else {
        return Ok(base);
    };
    let inputs = inputs
        .as_array()
        .ok_or_else(|| crate::err("Invalid captured team input list"))?;
    let mut assembled = Assembly::new(&base, inputs)?;
    for (index, input) in inputs.iter().enumerate() {
        let delivered = broker("/team_source", json!({"index":index}), true).await?;
        let files: Workspace =
            serde_json::from_value(delivered["files"].clone()).map_err(crate::err)?;
        assembled.apply(&delivered["input"], &files)?;
        // Do not accept a mutable/favorable subset even if the files happen to look correct.
        if delivered["input"] != *input {
            return Err(crate::err("Team input identity mismatch"));
        }
    }
    assembled.finish()
}
