//! Repository commands that change platform state: land, rebase, review, policy, tokens and
//! checks, plus `conflicts`. Commits may be named by local id inside a clone (the
//! helper's commit map translates them) or by platform id anywhere.
use crate::command::{CheckCommand, TokenCommand};
use crate::error::{Error, Result};
use crate::human;
use crate::output::{self, CheckStatus, Decision};
use crate::remote::map::CommitMap;
use crate::target::{self, Resolved};
use serde_json::{Value, json};

fn is_id(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The human text of a platform record: the record as indented JSON.
fn print(value: &Value) {
    human!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
    );
}

/// The platform commit for `spec` (a local or platform commit; default: HEAD in a
/// clone, else main's head). A clone's commits have the platform's ids, except the few
/// the commit map translates.
pub async fn platform_commit(t: &Resolved, spec: Option<&str>) -> Result<String> {
    if let Some(clone) = &t.clone {
        let local = clone.git.commit_of(spec.unwrap_or("HEAD")).ok();
        if let Some(local) = local {
            let map = CommitMap::open(&clone.git_dir, &t.repo)?;
            return Ok(map.server(&local).unwrap_or(&local).to_owned());
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

/// The clone's current branch, if inside one on a branch.
pub fn current_branch(t: &Resolved) -> Option<String> {
    t.clone
        .as_ref()
        .and_then(|c| c.git.run(&["symbolic-ref", "--short", "HEAD"]).ok())
}

pub async fn land(t: &Resolved, branch: Option<&str>) -> Result<()> {
    let branch = match branch {
        Some(b) => b.to_owned(),
        None => current_branch(t)
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
    let landed = land_head(t, &branch, &head, "main").await?;
    output::emit(&output::Land {
        branch,
        head,
        base: "main".into(),
        version: landed.version,
        merged: landed.merged,
    });
    Ok(())
}

/// What a landing answered.
pub struct Landed {
    pub version: Option<u64>,
    pub merged: bool,
}

/// Lands `head` on `base` (`what` names it in the report); a conflict names its paths.
pub async fn land_head(t: &Resolved, what: &str, head: &str, base: &str) -> Result<Landed> {
    match t.api.land(base, head).await {
        Ok(landed) => {
            let merged = landed.get("merge").is_some();
            human!(
                "Landed {what} ({head}) on {base} at version {}{}",
                landed["version"],
                if merged { " (merged)" } else { "" }
            );
            Ok(Landed {
                version: landed["version"].as_u64(),
                merged,
            })
        }
        Err(f) if f.code == "CONFLICT" => {
            let paths = crate::remote::land_conflict_paths(&f.details);
            Err(Error::conflict(format!(
                "landing refused: {}\n  conflicting: {}",
                f.message,
                paths.join(", ")
            ))
            .from_platform(&f.code))
        }
        Err(f) => Err(f.into()),
    }
}

/// `rebase`: replays the branch's commits onto `onto`'s head on the server and moves the
/// branch; a conflict names its paths and leaves the branch where it was.
pub async fn rebase(t: &Resolved, branch: &str, onto: Option<&str>) -> Result<()> {
    let onto = onto.unwrap_or("main");
    let path = format!("/branches/{}/rebase", crate::api::encode(branch));
    match t.api.post(&path, &json!({ "onto": onto })).await {
        Ok(done) if done["up_to_date"] == true => {
            human!("{branch} is already on {onto}");
            output::emit(&output::Rebase {
                branch: branch.to_owned(),
                onto: onto.to_owned(),
                up_to_date: true,
                replayed: 0,
                head: None,
            });
            Ok(())
        }
        Ok(done) => {
            let replayed = done["commits"].as_array().map_or(0, Vec::len);
            let head = done["head"].as_str().unwrap_or_default();
            human!("Rebased {branch} onto {onto}: {replayed} commit(s) replayed, now at {head}");
            output::emit(&output::Rebase {
                branch: branch.to_owned(),
                onto: onto.to_owned(),
                up_to_date: false,
                replayed: replayed as u64,
                head: Some(head.to_owned()),
            });
            Ok(())
        }
        Err(f) if f.code == "CONFLICT" => Err(Error::conflict(format!(
            "rebase refused, {branch} unchanged: {}\n  conflicting: {}",
            f.message,
            crate::remote::land_conflict_paths(&f.details).join(", ")
        ))
        .from_platform(&f.code)),
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
    human!("Recorded {decision} on {sha}");
    output::emit(&output::Review {
        commit: sha,
        decision: if approve {
            Decision::Approve
        } else {
            Decision::Reject
        },
    });
    Ok(())
}

pub async fn policy(t: &Resolved, set: Option<&str>) -> Result<()> {
    match set {
        None => {
            let policy = t.api.status().await?["policy"].clone();
            print(&policy);
            output::emit(&output::PolicyShow { policy });
        }
        Some(text) => {
            let policy: Value = serde_json::from_str(text)
                .map_err(|e| Error::usage(format!("the policy is not JSON: {e}")))?;
            let result = t.api.put("/policy", &json!({ "policy": policy })).await?;
            print(&result);
            output::emit(&output::PolicySet { result });
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
            human!("{secret}");
            output::emit(&output::TokenCreate {
                repo: t.repo.clone(),
                token: secret.to_owned(),
                name,
            });
        }
        TokenCommand::List => {
            let listed = t.api.get("/tokens").await?;
            print(&listed);
            let tokens = listed["tokens"].as_array().cloned().unwrap_or_default();
            output::emit(&output::TokenList { tokens });
        }
        TokenCommand::Revoke { name } => {
            t.api
                .delete(&format!("/tokens/{}", crate::api::encode(&name)))
                .await?;
            human!("Revoked {name}");
            output::emit(&output::TokenRevoke {
                repo: t.repo.clone(),
                name,
            });
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
            output::emit(&output::CheckRun {
                commit: sha,
                run: made,
            });
        }
        CheckCommand::Status { run: Some(id), .. } => {
            let run = t
                .api
                .get(&format!("/check-runs/{}", crate::api::encode(&id)))
                .await?;
            print(&run);
            output::emit(&CheckStatus::Run { run });
        }
        CheckCommand::Status { run: None, commit } => {
            let sha = platform_commit(t, commit.as_deref()).await?;
            let record = t.api.commit_record(&sha).await?;
            print(
                &json!({ "commit": sha, "checks": record["checks"], "check_runs": record["check_runs"], "gates": record["gates"] }),
            );
            output::emit(&CheckStatus::Commit {
                commit: sha,
                checks: record["checks"].clone(),
                check_runs: record["check_runs"].clone(),
                gates: record["gates"].clone(),
            });
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
            let message = record["message"].as_str().unwrap_or("landing refused");
            human!("{message}");
            let paths: Vec<&str> = record["paths"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| p.as_str().unwrap_or("?"))
                .collect();
            for path in &paths {
                human!("  {path}");
            }
            human!("next: git pull, resolve, commit, git push");
            output::emit(&output::Conflicts {
                refused: true,
                message: Some(message.to_owned()),
                paths: paths.into_iter().map(str::to_owned).collect(),
            });
        }
        Err(_) => {
            human!("No refused landing recorded");
            output::emit(&output::Conflicts {
                refused: false,
                message: None,
                paths: Vec::new(),
            });
        }
    }
    Ok(())
}
