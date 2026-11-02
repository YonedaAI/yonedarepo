//! `admin author-backfill --env <env> --dry-run|--confirm [--repo <id>]`: fills in who wrote
//! commits recorded before that was kept, from their Git objects, through the deployed
//! platform's `POST /api/v1/admin/repos/<id>/author-backfill` as the owner, 200 commits a call.
//! Every repository, or one. Repeating it fills nothing twice.
use crate::infra::spec::Env;
use crate::process::Result;
use serde_json::{Value, json};
use std::time::Duration;

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let at = args.iter().position(|a| a == name)?;
    args.get(at + 1).map(String::as_str)
}

/// One repository's totals: missing, filled, unreadable.
fn add(totals: &mut [u64; 3], page: &Value) {
    for (total, key) in totals.iter_mut().zip(["missing", "filled", "unreadable"]) {
        *total += page[key].as_u64().unwrap_or(0);
    }
}

async fn post(client: &reqwest::Client, url: &str, owner: &str, body: Value) -> Result<Value> {
    let response = client
        .post(url)
        .bearer_auth(owner)
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let page: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("{url}: HTTP {status}: {page}").into());
    }
    Ok(page)
}

/// Every repository's id, from the imports listing.
async fn every_repository(
    client: &reqwest::Client,
    origin: &str,
    owner: &str,
) -> Result<Vec<String>> {
    let (mut ids, mut after) = (Vec::new(), String::new());
    loop {
        let url = format!("{origin}/api/v1/admin/imports?after={after}");
        let page: Value = client
            .get(url)
            .bearer_auth(owner)
            .send()
            .await?
            .json()
            .await?;
        for row in page["repositories"].as_array().into_iter().flatten() {
            ids.extend(row["id"].as_str().map(str::to_owned));
        }
        match page["next"].as_str() {
            Some(next) => after = next.to_owned(),
            None => return Ok(ids),
        }
    }
}

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let dry_run = args.iter().any(|a| a == "--dry-run");
    if dry_run == args.iter().any(|a| a == "--confirm") {
        return Err("Pass --dry-run, or --confirm to fill them in".into());
    }
    let (_, _, origin, owner) = crate::admin::platform(&env)?;
    let client = crate::admin::platform_client(Duration::from_secs(120))?;
    let repositories = match option(args, "--repo") {
        Some(repo) => vec![repo.to_owned()],
        None => every_repository(&client, &origin, &owner).await?,
    };
    let mut all = [0; 3];
    for repo in &repositories {
        let url = format!("{origin}/api/v1/admin/repos/{repo}/author-backfill");
        let mut totals = [0; 3];
        let mut after = String::new();
        loop {
            let body = json!({ "after": after, "dry_run": dry_run });
            let page = match post(&client, &url, &owner, body).await {
                Ok(page) => page,
                // Deleted since the list was read: nothing of it to fill in.
                Err(e) if e.to_string().contains("\"GONE\"") => break,
                Err(e) => return Err(e),
            };
            add(&mut totals, &page);
            match page["next"].as_str() {
                Some(next) => after = next.to_owned(),
                None => break,
            }
        }
        if totals[0] > 0 {
            println!(
                "{repo}: {} missing, {} filled, {} unreadable",
                totals[0], totals[1], totals[2]
            );
        }
        for (total, one) in all.iter_mut().zip(totals) {
            *total += one;
        }
    }
    println!(
        "{} repositories: {} missing, {} filled, {} unreadable",
        repositories.len(),
        all[0],
        all[1],
        all[2]
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::add;
    use serde_json::json;

    #[test]
    fn adds_up_pages_and_counts_what_a_page_leaves_out_as_none() {
        let mut totals = [0; 3];
        add(
            &mut totals,
            &json!({"missing":200,"filled":198,"unreadable":2}),
        );
        add(&mut totals, &json!({"missing":5}));
        assert_eq!(totals, [205, 198, 2]);
    }
}
