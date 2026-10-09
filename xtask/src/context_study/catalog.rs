use crate::process::Result;
use serde_json::{Value, json};
use std::path::Path;
pub(super) fn cases() -> Result<Vec<Value>> {
    Ok(serde_json::from_str(include_str!(
        "../../../fixtures/context-study/cases.json"
    ))?)
}
pub(super) fn corpus() -> Result<Vec<Value>> {
    Ok(serde_json::from_str(include_str!(
        "../../../fixtures/context-study/corpus.json"
    ))?)
}
pub(super) fn manifest() -> Result<Value> {
    let cases = cases()?;
    let mut trials = Vec::new();
    for repetition in 0..3 {
        for case in &cases {
            // Latin-square order; every case uses each arm in every ordinal position.
            for offset in 0..3 {
                let arm = ["source_only", "plain_notes", "graph"][(offset + repetition) % 3];
                trials.push(json!({"case":case["id"],"arm":arm,"repetition":repetition+1,
                    "executions":case["executions"],"model_assignment":if repetition % 2 == 0 {"mimo_then_zai"}else{"zai_then_mimo"}}));
            }
        }
    }
    Ok(
        json!({"version":1,"design":"limited controlled pilot, no statistical population claim",
        "cases":cases,"corpus":corpus()?,"trials":trials,"trial_clusters":27,"planned_executions":45,
        "hosted_model_requests_per_group":60,"local_cli_max_turns":60,"request_limit_semantics":"CLI turns are not identical to durable proxy request accounting","output_tokens":4096,"execution_ms":600000,
        "oracle":"fixtures/context-study/oracle/check.mjs","oracle_access":"outside agent checkout; read-only network-disabled container"}),
    )
}
pub(super) fn verify_files() -> Result<()> {
    let fixture = yoneda_runtime::export_workspace(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/context-study/source"),
    )?;
    if fixture
        .keys()
        .any(|path| path.contains("oracle") || path.contains("corpus"))
    {
        return Err("Control data leaked into the agent source fixture".into());
    }
    if corpus()?.len() != 3 || cases()?.len() != 3 {
        return Err("Incomplete study fixture".into());
    }
    Ok(())
}
