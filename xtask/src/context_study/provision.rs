use super::{
    client::{Client, text},
    git,
};
use crate::process::Result;
use serde_json::{Value, json};
pub(super) struct Project {
    pub id: String,
    pub grant: String,
    pub grant_id: String,
    pub base: String,
}
pub(super) async fn prepare(client: &Client, trial: &Value, study: &str) -> Result<Project> {
    let project=client.api("projects",Some(json!({"request_id":uuid::Uuid::new_v4().to_string(),"name":format!("Context study {study}: {} {} {}",trial["case"],trial["arm"],trial["repetition"])}))).await?;
    let id = text(&project, "id")?.to_owned();
    for _ in 0..30 {
        let ready = client.api(&format!("projects/{id}"), None).await?;
        if ready["status"] == "ready" {
            break;
        }
        if ready["status"] == "failed" {
            return Err("Study fixture project preparation failed".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    let access=client.api(&format!("repos/{id}/grants"),Some(json!({"label":"Disposable controlled context pilot","scope":"contribute","days":1}))).await?;
    let grant = text(&access, "token")?.to_owned();
    let grant_id = text(&access, "id")?.to_owned();
    let result = seed_and_configure(client, trial, study, &id, &grant, &grant_id).await;
    if let Err(error) = result {
        let revoked = client
            .api(
                &format!("repos/{id}/grants"),
                Some(json!({"revoke":grant_id})),
            )
            .await
            .is_ok();
        return Err(format!("Setup failed for {id}; grant revoked={revoked}: {error}").into());
    }
    result
}
async fn seed_and_configure(
    client: &Client,
    trial: &Value,
    study: &str,
    id: &str,
    grant: &str,
    grant_id: &str,
) -> Result<Project> {
    let capability = client.api(&format!("repos/{id}/snapshot"), None).await?;
    if capability["capabilities"]["context_usage"] != 1 {
        return Err("Deploy the context-usage ledger before starting a trial".into());
    }
    let session = client.session(id, grant).await?;
    let seed=client.mcp(id,grant,Some(&session),"attempt_begin",json!({"request_id":uuid::Uuid::new_v4().to_string(),"intent":"Seed explicitly synthetic context pilot fixture","criteria":["Valid static source; no paid inference"]})).await?;
    let attempt = text(&seed, "attempt_id")?;
    let temp = tempfile::tempdir()?;
    let _submitted_commit = git::seed(
        temp.path(),
        grant,
        text(&seed, "git_url")?,
        text(&seed["base"], "commit")?,
    )
    .await?;
    let mut corpus = Vec::new();
    for record in super::catalog::corpus()? {
        // Fixed IDs and text keep notes identical across arms. Origin is honestly owner-seeded.
        client.api(&format!("repos/{id}/context_publish"),Some(json!({"record":{
            "id":record["id"],"kind":record["kind"],"statement":record["statement"],
            "purpose":format!("Synthetic benchmark corpus, not real owner acceptance. {}",record["purpose"].as_str().unwrap_or_default()),
            "intent_id":seed["intent_id"],"links":[]}}))).await?;
        corpus.push(record["id"].clone());
    }
    client
        .mcp(
            id,
            grant,
            Some(&session),
            "attempt_submit",
            json!({"attempt_id":attempt}),
        )
        .await?;
    let snapshot = super::run::wait(client, id, text(&seed["run"], "id")?, 240).await?;
    let candidate = snapshot["candidates"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|c| c["run_id"] == seed["run"]["id"] && c["status"] == "eligible")
        })
        .ok_or("Fixture did not pass independent platform checks")?;
    let commit = text(&candidate["revision"], "commit")?.to_owned();
    client.api(&format!("repos/{id}/accept"),Some(json!({"request_id":uuid::Uuid::new_v4().to_string(),"candidate":candidate["id"],"expected_commit":snapshot["repository"]["head_commit"],"expected_version":snapshot["repository"]["version"],"decision_kind":"development_verification","rationale":"Automated publication of a synthetic test fixture, not a human selection","alternatives":[]}))).await?;
    for _ in 0..48 {
        let snapshot = client.api(&format!("repos/{id}/snapshot"), None).await?;
        if snapshot["repository"]["pending"].is_null()
            && snapshot["repository"]["published_commit"] == commit
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    let current = client.api(&format!("repos/{id}/snapshot"), None).await?;
    if !current["repository"]["pending"].is_null()
        || current["repository"]["published_commit"] != commit
    {
        return Err("Fixture publication did not read back".into());
    }
    client.api(&format!("repos/{id}/configure_context_study"),Some(json!({"context_study":{"id":study,"case":trial["case"],"arm":trial["arm"],"corpus":corpus}}))).await?;
    Ok(Project {
        id: id.to_owned(),
        grant: grant.to_owned(),
        grant_id: grant_id.to_owned(),
        base: commit,
    })
}
