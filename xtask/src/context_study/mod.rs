//! Reproducible controls and explicitly invoked paid pilot; no inference in local gates.
mod catalog;
mod client;
mod git;
mod local;
mod oracle;
mod provision;
mod recheck;
mod report;
mod run;
mod task;
use crate::process::Result;
use serde_json::Value;
use std::path::Path;
fn option<'a>(args: &'a [String], key: &str, default: &'a str) -> &'a str {
    args.windows(2)
        .find(|v| v[0] == key)
        .map_or(default, |v| v[1].as_str())
}
pub(crate) async fn execute(args: &[String]) -> Result<()> {
    catalog::verify_files()?;
    let manifest = catalog::manifest()?;
    let directory = Path::new(option(args, "--output", "artifacts/context-study"));
    let command = args.get(1).map_or("plan", String::as_str);
    if command == "plan" {
        report::write(directory, &manifest, &[])?;
        println!(
            "Prepared 27 balanced clusters / 45 planned executions. No inference. {}",
            directory.display()
        );
        return Ok(());
    }
    if command == "verify-controls" {
        let checks = oracle::self_check().await?;
        std::fs::create_dir_all(directory)?;
        std::fs::write(
            directory.join("control-checks.json"),
            serde_json::to_vec_pretty(&checks)?,
        )?;
        println!("Synthetic baseline, reference and regression controls verified; no inference.");
        return Ok(());
    }
    if command == "recheck" {
        oracle::self_check().await?;
        let client = client::Client::login(
            option(args, "--url", "http://127.0.0.1:8787"),
            Path::new(option(args, "--credentials", ".local/product-user.json")),
        )
        .await?;
        recheck::execute(
            &client,
            Path::new(option(args, "--input", "artifacts/context-study")),
            directory,
        )
        .await?;
        return Ok(());
    }
    if command != "run" {
        return Err("Use context-study plan|verify-controls|run|recheck [--url URL --credentials private.json --input DIR --output DIR --limit N]".into());
    }
    // Required before any paid work; never infer success from a pre-existing report.
    oracle::self_check().await?;
    let credentials = Path::new(option(args, "--credentials", ".local/product-user.json"));
    let client =
        client::Client::login(option(args, "--url", "http://127.0.0.1:8787"), credentials).await?;
    let settings = client.api("settings", None).await?;
    let providers = settings["providers"]
        .as_array()
        .ok_or("No provider settings")?;
    let mut connections = Vec::new();
    for provider in ["mimo", "zai"] {
        connections.push(
            providers
                .iter()
                .find(|p| p["provider"] == provider)
                .ok_or("Pilot requires saved MiMo and ZAI connections")?
                .clone(),
        );
    }
    let limit: usize = option(args, "--limit", "27").parse()?;
    if !(1..=27).contains(&limit) {
        return Err("Choose a cluster limit of 1–27".into());
    }
    let study = format!("pilot-{}", uuid::Uuid::new_v4());
    let cases = catalog::cases()?;
    let mut results = Vec::new();
    report::write(directory, &manifest, &results)?;
    let trials = manifest["trials"].as_array().ok_or("Missing trials")?;
    let secret_input: Value = serde_json::from_slice(&std::fs::read(credentials)?)?;
    for wave in trials[..limit].chunks(3) {
        let (a, b, c) = tokio::join!(
            task::execute(
                &client,
                wave.first(),
                &cases,
                &connections,
                credentials,
                &study
            ),
            task::execute(
                &client,
                wave.get(1),
                &cases,
                &connections,
                credentials,
                &study
            ),
            task::execute(
                &client,
                wave.get(2),
                &cases,
                &connections,
                credentials,
                &study
            )
        );
        for mut result in [a, b, c].into_iter().flatten() {
            report::redact(&mut result, &secret_input);
            results.push(result);
        }
        report::write(directory, &manifest, &results)?;
        println!("Recorded {} of {limit} requested clusters", results.len());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn balanced_complete_manifest() {
        let m = super::catalog::manifest().unwrap();
        let trials = m["trials"].as_array().unwrap();
        assert_eq!(trials.len(), 27);
        assert_eq!(
            trials
                .iter()
                .filter_map(|t| t["executions"].as_u64())
                .sum::<u64>(),
            45
        );
        for case in ["website_update", "delegation", "local_continuation"] {
            for arm in ["source_only", "plain_notes", "graph"] {
                assert_eq!(
                    trials
                        .iter()
                        .filter(|t| t["case"] == case && t["arm"] == arm)
                        .count(),
                    3
                );
            }
        }
        super::catalog::verify_files().unwrap();
    }
}
