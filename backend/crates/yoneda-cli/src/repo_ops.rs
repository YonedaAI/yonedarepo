//! Repository commands that change platform state: land, review, policy, tokens and
//! checks, plus `conflicts`. Commits may be named by local id inside a clone (the
//! helper's commit map translates them) or by platform id anywhere.
use crate::command::{CheckCommand, TokenCommand};
use crate::error::{Error, Result};
use crate::remote::map::CommitMap;
use crate::target::{self, Resolved};
use serde_json::{Value, json};

fn is_id(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn print(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
    );
}

/// The platform commit for `spec` (a local or platform commit; default: HEAD in a
/// clone, else main's head).
pub async fn platform_commit(t: &Resolved, spec: Option<&str>) -> Result<String> {
    if let Some(clone) = &t.clone {
        let local = clone.git.commit_of(spec.unwrap_or("HEAD")).ok();
        if let Some(local) = local {
            let map = CommitMap::open(&clone.git_dir, &t.repo)?;
            if let Some(server) = map.server(&local) {
                return Ok(server.to_owned());
            }
            if spec.is_none() {
                return Err(Error::new(format!(
                    "HEAD ({local}) is not on the platform yet: git push it first"
                )));
            }
        }
    }
    match spec {
        Some(id) if is_id(id) => Ok(id.to_owned()),
        Some(other) => Err(Error::new(format!(
            "{other} is not a commit this clone pushed; pass a platform commit id"
        ))),
        None => Ok(t.api.branch_at_latest("main").await?.1),
    }
}

pub async fn land(t: &Resolved, branch: Option<&str>) -> Result<()> {
    let branch = match branch {
        Some(b) => b.to_owned(),
        None => t
            .clone
            .as_ref()
            .and_then(|c| c.git.run(&["symbolic-ref", "--short", "HEAD"]).ok())
            .ok_or_else(|| Error::usage("land needs --branch <b> outside a clone"))?,
    };
    if branch == "main" {
        return Err(Error::usage(
            "main is the landing target: push a branch, then `yoneda land --branch <b>`",
        ));
    }
    let head = t.api.branch_head(&branch).await?.ok_or_else(|| {
        Error::new(format!(
            "the platform has no branch {branch}; git push it first"
        ))
    })?;
    match t.api.land("main", &head).await {
        Ok(landed) => {
            println!(
                "Landed {branch} ({head}) on main at version {}{}",
                landed["version"],
                if landed.get("merge").is_some() {
                    " (merged)"
                } else {
                    ""
                }
            );
            Ok(())
        }
        Err(f) if f.code == "CONFLICT" => {
            let paths = crate::remote::land_conflict_paths(&f.details);
            Err(Error::conflict(format!(
                "landing refused: {}\n  conflicting: {}",
                f.message,
                paths.join(", ")
            )))
        }
        Err(f) => Err(f.into()),
    }
}

pub async fn review(t: &Resolved, approve: bool, commit: &str, reason: Option<&str>) -> Result<()> {
    let sha = platform_commit(t, Some(commit)).await?;
    let decision = if approve { "approve" } else { "reject" };
    let body = json!({ "decision": decision, "reason": reason.unwrap_or("") });
    t.api
        .post(&format!("/commits/{sha}/reviews"), &body)
        .await?;
    println!("Recorded {decision} on {sha}");
    Ok(())
}

pub async fn policy(t: &Resolved, set: Option<&str>) -> Result<()> {
    match set {
        None => print(&t.api.status().await?["policy"]),
        Some(text) => {
            let policy: Value = serde_json::from_str(text)
                .map_err(|e| Error::usage(format!("the policy is not JSON: {e}")))?;
            print(&t.api.put("/policy", &json!({ "policy": policy })).await?);
        }
    }
    Ok(())
}

pub async fn token(t: &Resolved, command: TokenCommand) -> Result<()> {
    match command {
        TokenCommand::Create {
            name,
            scopes,
            paths,
        } => {
            let body = json!({ "name": name, "scopes": scopes, "paths": paths });
            let made = t.api.post("/tokens", &body).await?;
            let secret = made["token"]
                .as_str()
                .ok_or_else(|| Error::new("the platform returned no token"))?;
            eprintln!("Repository token {name} for {} (shown once):", t.repo);
            println!("{secret}");
        }
        TokenCommand::List => print(&t.api.get("/tokens").await?),
        TokenCommand::Revoke { name } => {
            t.api
                .delete(&format!("/tokens/{}", crate::api::encode(&name)))
                .await?;
            println!("Revoked {name}");
        }
    }
    Ok(())
}

pub async fn check(t: &Resolved, command: CheckCommand) -> Result<()> {
    match command {
        CheckCommand::Run { name, commit } => {
            let sha = platform_commit(t, commit.as_deref()).await?;
            let made = t
                .api
                .post(
                    &format!("/commits/{sha}/check-runs"),
                    &json!({ "name": name }),
                )
                .await?;
            print(&made);
        }
        CheckCommand::Status { run: Some(id), .. } => {
            print(
                &t.api
                    .get(&format!("/check-runs/{}", crate::api::encode(&id)))
                    .await?,
            );
        }
        CheckCommand::Status { run: None, commit } => {
            let sha = platform_commit(t, commit.as_deref()).await?;
            let record = t.api.commit_record(&sha).await?;
            print(
                &json!({ "commit": sha, "checks": record["checks"], "check_runs": record["check_runs"], "gates": record["gates"] }),
            );
        }
    }
    Ok(())
}

/// `yoneda conflicts`: the paths of the last landing the helper saw refused.
pub fn conflicts() -> Result<()> {
    let clone =
        target::current_clone().ok_or_else(|| Error::usage("conflicts runs inside a clone"))?;
    let repo = clone
        .remote
        .as_ref()
        .map(|r| r.repo.clone())
        .ok_or_else(|| Error::usage("this clone has no yoneda remote"))?;
    let file = crate::remote::conflict_file(&clone.git_dir, &repo);
    match std::fs::read(&file) {
        Ok(raw) => {
            let record: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
            println!(
                "{}",
                record["message"].as_str().unwrap_or("landing refused")
            );
            for path in record["paths"].as_array().into_iter().flatten() {
                println!("  {}", path.as_str().unwrap_or("?"));
            }
            println!("next: git pull, resolve, commit, git push");
        }
        Err(_) => println!("No refused landing recorded"),
    }
    Ok(())
}
