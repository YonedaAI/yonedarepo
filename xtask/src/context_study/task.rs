use super::{client::Client, local, provision, run};
use serde_json::{Value, json};
use std::path::Path;
pub(super) async fn execute(
    client: &Client,
    trial: Option<&Value>,
    cases: &[Value],
    connections: &[Value],
    credentials: &Path,
    study: &str,
) -> Option<Value> {
    let trial = trial?;
    let case = cases.iter().find(|c| c["id"] == trial["case"])?;
    println!(
        "Starting synthetic {} {} repetition {}",
        trial["case"], trial["arm"], trial["repetition"]
    );
    let mut result = json!({"trial":trial,"study_id":study,"evidence":null,"error":null,"unsupported_claims":null});
    match provision::prepare(client, trial, study).await {
        Ok(project) => {
            result["repo_id"] = json!(project.id);
            let attempt = if case["id"] == "local_continuation" {
                let first = usize::from(trial["model_assignment"] == "zai_then_mimo");
                local::execute(client, &project, case, &connections[first], credentials).await
            } else {
                run::hosted(client, &project, trial, case, connections)
                    .await
                    .map(|id| (id, Value::Null))
            };
            match attempt {
                Ok((id, metrics)) => {
                    result["run_id"] = json!(id);
                    match run::collect(
                        client,
                        &project,
                        &id,
                        case["id"].as_str().unwrap_or_default(),
                    )
                    .await
                    {
                        Ok(evidence) => result["evidence"] = evidence,
                        Err(error) => {
                            result["error"] = json!(format!("Collection failed: {error}"));
                            let _ = client
                                .api(
                                    &format!("repos/{}/cancel_run", project.id),
                                    Some(json!({"run_id":id})),
                                )
                                .await;
                        }
                    }
                    result["local_metrics"] = metrics;
                }
                Err(error) => {
                    result["error"] = json!(format!("Execution start failed: {error}"));
                    result["recovery"] = recover(client, &project, case).await;
                }
            }
            result["grant_revoked"] = json!(
                client
                    .api(
                        &format!("repos/{}/grants", project.id),
                        Some(json!({"revoke":project.grant_id}))
                    )
                    .await
                    .is_ok()
            );
        }
        Err(error) => result["error"] = json!(format!("Setup failed: {error}")),
    }
    let observations = result["evidence"]["observations"].as_array();
    result["cluster_complete"] = json!(observations.is_some_and(|items| items.len() as u64
        == trial["executions"].as_u64().unwrap_or(0)
        && items.iter().all(|item| item["oracle"].is_object())));
    Some(result)
}

// Acknowledgment loss may hide a created run ID. Each trial owns a dedicated
// repository, so recover every study run without touching the fixture seed run.
async fn recover(client: &Client, project: &provision::Project, case: &Value) -> Value {
    let Ok(snapshot) = client
        .api(&format!("repos/{}/snapshot", project.id), None)
        .await
    else {
        return json!({"error":"Recovery snapshot unavailable; inspect trial repository"});
    };
    let mut recovered = Vec::new();
    for run in snapshot["runs"].as_array().into_iter().flatten() {
        if run["intent"] != case["brief"] {
            continue;
        }
        let Some(id) = run["id"].as_str() else {
            continue;
        };
        let cancelled = client
            .api(
                &format!("repos/{}/cancel_run", project.id),
                Some(json!({"run_id":id})),
            )
            .await
            .is_ok();
        let evidence =
            run::collect(client, project, id, case["id"].as_str().unwrap_or_default()).await;
        recovered.push(match evidence {
            Ok(evidence) => json!({"run_id":id,"cancelled":cancelled,"evidence":evidence}),
            Err(_) => json!({"run_id":id,"cancelled":cancelled,"collection_error":true}),
        });
    }
    json!({"runs":recovered})
}
