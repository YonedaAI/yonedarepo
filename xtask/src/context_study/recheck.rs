//! Re-evaluate existing immutable captures; no agent execution or source publication.
use super::{client::Client, oracle, report, run};
use crate::process::Result;
use serde_json::{Value, json};
use std::path::Path;

pub(super) async fn execute(client: &Client, input: &Path, output: &Path) -> Result<()> {
    std::fs::create_dir_all(output)?;
    if input.canonicalize()? == output.canonicalize()? {
        return Err("Use a separate output directory to preserve the original observations".into());
    }
    let manifest: Value = serde_json::from_slice(&std::fs::read(input.join("manifest.json"))?)?;
    let mut results: Vec<Value> =
        serde_json::from_slice(&std::fs::read(input.join("results.json"))?)?;
    let mut count = 0;
    for result in &mut results {
        let repo = result["repo_id"]
            .as_str()
            .ok_or("Missing trial repository")?
            .to_owned();
        let case = result["trial"]["case"]
            .as_str()
            .ok_or("Missing trial case")?
            .to_owned();
        let Some(observations) = result["evidence"]["observations"].as_array_mut() else {
            continue;
        };
        for observation in observations {
            let candidate = &observation["candidate"];
            let Some(id) = candidate["id"].as_str() else {
                continue;
            };
            let query = reqwest::Url::parse_with_params("https://query.invalid", [("id", id)])?;
            let captured = client
                .api(
                    &format!(
                        "repos/{repo}/candidate_source?{}",
                        query.query().unwrap_or_default()
                    ),
                    None,
                )
                .await?;
            if captured["revision"] != candidate["revision"] {
                return Err("Recheck source revision mismatch".into());
            }
            let files: yoneda_core::Workspace = serde_json::from_value(captured["files"].clone())?;
            let temp = tempfile::tempdir()?;
            yoneda_runtime::materialize(temp.path(), &files)?;
            let outcome = oracle::check(
                temp.path(),
                run::oracle_feature(&case, observation["parent_execution"].is_string()),
            )
            .await?;
            observation["oracle_previous"] = observation["oracle"].clone();
            observation["oracle"] = outcome;
            count += 1;
        }
        result["oracle_recheck"] = json!({"version":"context-fixture-v2","no_inference":true,"reason":"Align privacy oracle with corpus: anonymous event flags are permitted; attendee identity is not"});
    }
    report::write(output, &manifest, &results)?;
    println!(
        "Rechecked {count} exact captured revisions without inference; original results preserved."
    );
    Ok(())
}
