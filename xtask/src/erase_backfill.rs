//! `admin erase-backfill --env <env> --dry-run|--confirm`: erases repositories deleted before
//! `REPO_ERASE`, or whose jobs were lost. D1 forgets a repository when it is deleted, so
//! tombstones are found from Cloudflare's object list: ids, not names, walked one at a time
//! through the deployed platform's `POST /api/v1/admin/erase-backfill`, which asks each object
//! itself (waking every repository, live ones included: one read, no write). With `--confirm`
//! each tombstone's erase runs to its end before the next object. Repeating is safe (an erased
//! repository answers `erased`), and `--after <cursor>` skips the pages already done.
use crate::infra::live::{Client, token};
use crate::infra::spec::Env;
use crate::process::Result;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;

const CLASS: &str = "SourceRepository";
const PAGE: u32 = 1000;
const DEFAULT_DELAY_MS: u64 = 1000;
const POLL: Duration = Duration::from_secs(5);
/// Past this one erase stops the walk: its job keeps running, and a repeat finds it erased.
const ERASE_POLLS: u32 = 360;

pub(crate) fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}

/// The repository class's namespace in `script`, from Cloudflare's listing.
fn namespace(listing: &Value, script: &str) -> Option<String> {
    listing["result"]
        .as_array()?
        .iter()
        .find(|n| n["class"] == CLASS && n["script"] == script)?["id"]
        .as_str()
        .map(str::to_owned)
}

/// A page of the object list: the ids holding data (an object without any has no tombstone,
/// and asking would create one) and the cursor of the next page.
fn stored_objects(page: &Value) -> (Vec<String>, Option<String>) {
    let ids = page["result"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|o| o["hasStoredData"] == true)
        .filter_map(|o| o["id"].as_str().map(str::to_owned))
        .collect();
    let cursor = page["result_info"]["cursor"]
        .as_str()
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    (ids, cursor)
}

struct Platform {
    client: reqwest::Client,
    origin: String,
    owner: String,
}

impl Platform {
    async fn ask(&self, object: &str, dry_run: bool) -> Result<Value> {
        let response = self
            .client
            .post(format!("{}/api/v1/admin/erase-backfill", self.origin))
            .bearer_auth(&self.owner)
            .json(&json!({ "object": object, "dry_run": dry_run }))
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(format!("object {object}: HTTP {status}: {body}").into());
        }
        Ok(body)
    }

    /// Waits out one queued erase; false when it did not end in time.
    async fn erased(&self, object: &str) -> Result<bool> {
        for _ in 0..ERASE_POLLS {
            tokio::time::sleep(POLL).await;
            let state = self.ask(object, true).await?;
            // Held back for its hooks: its job comes back alone, so the walk goes on.
            if state["state"] == "erased" || state["waiting"] == true {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let (dry_run, confirmed) = (
        args.iter().any(|a| a == "--dry-run"),
        args.iter().any(|a| a == "--confirm"),
    );
    if dry_run == confirmed {
        return Err("Pass --dry-run, or --confirm to erase".into());
    }
    let (spec, workers, origin, owner) = crate::admin::platform(&env)?;
    let script = workers
        .iter()
        .find(|w| w.role == "platform")
        .map(|w| w.name.clone())
        .ok_or("No platform Worker in the spec")?;
    let delay = match option(args, "--delay-ms") {
        Some(ms) => Duration::from_millis(ms.parse()?),
        None => Duration::from_millis(DEFAULT_DELAY_MS),
    };
    let limit: Option<usize> = option(args, "--limit").map(str::parse).transpose()?;
    let cloudflare = Client::new(token(args)?);
    let namespaces = format!(
        "/accounts/{}/workers/durable_objects/namespaces",
        spec.account_id
    );
    let listing = cloudflare
        .get(&format!("{namespaces}?per_page=1000"))
        .await?;
    let id = namespace(&listing, &script).ok_or("The platform has no repository namespace")?;
    let platform = Platform {
        client: crate::admin::platform_client(Duration::from_secs(120))?,
        origin,
        owner,
    };
    let mut cursor = option(args, "--after").map(str::to_owned);
    let mut states = BTreeMap::<String, u64>::new();
    let (mut asked, mut bytes) = (0, 0);
    'walk: loop {
        let after = cursor
            .as_ref()
            .map(|c| format!("&cursor={c}"))
            .unwrap_or_default();
        let page = cloudflare
            .get(&format!("{namespaces}/{id}/objects?limit={PAGE}{after}"))
            .await?;
        let (objects, next) = stored_objects(&page);
        for object in objects {
            if limit.is_some_and(|limit| asked >= limit) {
                break 'walk;
            }
            asked += 1;
            let answer = platform.ask(&object, dry_run).await?;
            let state = answer["state"].as_str().unwrap_or("unknown").to_owned();
            if state != "live" {
                let size = answer["db_bytes"].as_u64().unwrap_or(0);
                bytes += size;
                println!(
                    "{state} {object} {} {size}",
                    answer["repo"].as_str().unwrap_or("-")
                );
            }
            if state == "queued" && !platform.erased(&object).await? {
                return Err(format!(
                    "{object} did not finish in time; repeat from --after {}",
                    cursor.as_deref().unwrap_or("the start")
                )
                .into());
            }
            *states.entry(state).or_default() += 1;
            tokio::time::sleep(delay).await;
        }
        match next {
            Some(next) => {
                println!("page done: --after {next}");
                cursor = Some(next);
            }
            None => break,
        }
    }
    println!(
        "{}: {asked} objects asked, {bytes} bytes outside live repositories: {states:?}",
        env.name()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_repository_namespace_of_the_platform_worker() {
        let listing = json!({"result": [
            {"id": "other", "class": "SourceRepository", "script": "yonedarepo-dev-agents"},
            {"id": "shards", "class": "CommitShard", "script": "yonedarepo-dev-platform"},
            {"id": "repos", "class": "SourceRepository", "script": "yonedarepo-dev-platform"},
        ]});
        assert_eq!(
            namespace(&listing, "yonedarepo-dev-platform").as_deref(),
            Some("repos")
        );
        assert_eq!(namespace(&listing, "yonedarepo-prod-platform"), None);
    }

    #[test]
    fn asks_only_objects_with_data_and_stops_at_the_last_page() {
        let page = json!({
            "result": [{"id": "a", "hasStoredData": true}, {"id": "b", "hasStoredData": false}],
            "result_info": {"cursor": "next"},
        });
        assert_eq!(
            stored_objects(&page),
            (vec!["a".to_owned()], Some("next".to_owned()))
        );
        let last = json!({"result": [], "result_info": {"cursor": ""}});
        assert_eq!(stored_objects(&last), (Vec::new(), None));
    }
}
