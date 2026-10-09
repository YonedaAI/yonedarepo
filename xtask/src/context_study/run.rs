use super::{
    client::{Client, text},
    provision::Project,
};
use crate::process::Result;
use serde_json::{Value, json};
pub(super) async fn wait(client: &Client, repo: &str, run: &str, seconds: u64) -> Result<Value> {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
    loop {
        let snapshot = client.api(&format!("repos/{repo}/snapshot"), None).await?;
        let executions = snapshot["executions"]
            .as_array()
            .ok_or("Missing execution state")?;
        let matching: Vec<_> = executions.iter().filter(|e| e["run_id"] == run).collect();
        let busy = matching.is_empty()
            || matching.iter().any(|e| {
                !["completed", "failed", "cancelled"]
                    .iter()
                    .any(|status| e["status"] == *status)
            });
        if !busy {
            return Ok(snapshot);
        }
        if std::time::Instant::now() > until {
            client
                .api(
                    &format!("repos/{repo}/cancel_run"),
                    Some(json!({"run_id":run})),
                )
                .await?;
            return client.api(&format!("repos/{repo}/snapshot"), None).await;
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
pub(super) async fn hosted(
    client: &Client,
    project: &Project,
    trial: &Value,
    case: &Value,
    connections: &[Value],
) -> Result<String> {
    let first = usize::from(trial["model_assignment"] == "zai_then_mimo");
    let count = if case["id"] == "delegation" { 1 } else { 2 };
    let strategies = case["strategies"].as_array().ok_or("No trial strategies")?;
    let agents:Vec<Value>=(0..count).map(|i|{let connection=&connections[(i+first)%2];json!({"provider":connection["provider"],"connection":connection["id"],"model":connection["model"],"strategy":strategies[i]})}).collect();
    let budgets:Vec<Value>=agents.iter().map(|agent|json!({"provider":agent["provider"],"model":agent["model"],"max_requests":60,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":null,"pricing":null})).collect();
    let id = format!("study-{}", uuid::Uuid::new_v4());
    client.api(&format!("repos/{}/start_run",project.id),Some(json!({"id":id,"intent":case["brief"],"criteria":case["criteria"],"agents":agents,"context":[],"model_budgets":budgets,"delegation":{"enabled":count==1,"max_depth":if count==1{1}else{0},"max_executions":2}}))).await?;
    Ok(id)
}
pub(super) async fn collect(
    client: &Client,
    project: &Project,
    run: &str,
    case: &str,
) -> Result<Value> {
    let snapshot = wait(client, &project.id, run, 960).await?;
    let usage = client
        .api(
            &format!("repos/{}/context_usage?run_id={run}&limit=100", project.id),
            None,
        )
        .await?;
    let mut pages = vec![usage.clone()];
    let mut current = usage;
    while current["has_more"] == true {
        current = client
            .api(
                &format!(
                    "repos/{}/context_usage?run_id={run}&limit=100&cursor={}",
                    project.id, current["next_cursor"]
                ),
                None,
            )
            .await?;
        pages.push(current.clone());
    }
    let mut observations = Vec::new();
    let candidates = snapshot["candidates"]
        .as_array()
        .ok_or("Missing candidates")?;
    for execution in snapshot["executions"]
        .as_array()
        .ok_or("Missing executions")?
        .iter()
        .filter(|e| e["run_id"] == run)
    {
        let candidate = candidates
            .iter()
            .find(|c| c["execution"] == execution["id"]);
        let mut observed = json!({"execution_id":execution["id"],"model":execution["model"],"provider":execution["provider"],"parent_execution":execution["parent_execution"],"status":execution["status"],"failure":execution["error"],"candidate":candidate,"oracle":null,"provider_tokens":null});
        if let Some(candidate) = candidate {
            let temp = tempfile::tempdir()?;
            let query = reqwest::Url::parse_with_params(
                "https://query.invalid",
                [("id", text(candidate, "id")?)],
            )?;
            let captured = client
                .api(
                    &format!(
                        "repos/{}/candidate_source?{}",
                        project.id,
                        query.query().unwrap_or_default()
                    ),
                    None,
                )
                .await?;
            if captured["revision"] != candidate["revision"] {
                return Err("Oracle source revision mismatch".into());
            }
            let files: yoneda_core::Workspace = serde_json::from_value(captured["files"].clone())?;
            yoneda_runtime::materialize(temp.path(), &files)?;
            let feature = oracle_feature(case, execution["parent_execution"].is_string());
            observed["oracle"] = super::oracle::check(temp.path(), feature).await?;
        }
        observations.push(observed);
    }
    Ok(
        json!({"repo_id":project.id,"run_id":run,"base":project.base,"usage_pages":pages,"observations":observations,
        "run":snapshot["runs"].as_array().and_then(|items|items.iter().find(|r|r["id"]==run)),"evaluations":snapshot["evaluations"].as_array().map(|items|items.iter().filter(|e| candidates.iter().any(|c|c["run_id"]==run&&c["id"]==e["candidate"])).collect::<Vec<_>>())}),
    )
}

pub(super) fn oracle_feature(case: &str, child: bool) -> &'static str {
    match case {
        "delegation" if !child => "search",
        "delegation" | "local_continuation" => "rsvp",
        _ => "all",
    }
}
