//! Ordinary owner guided workflow. Progress is computed solely from native ledger evidence.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
mod binding;
mod evidence;
mod retry;
mod start;
pub(crate) use binding::{evaluation_binding, freeze, validate_report};
pub(crate) fn validate_publish<S: SqlStore>(db: &S, candidate: &Value) -> Result<()> {
    let Some(binding) = evaluation_binding(db, candidate)? else {
        return Ok(());
    };
    let session = load(db, &string(&binding, "session_id")?)?;
    let view = evidence::view(db, &session)?;
    let evaluation = get(db, "evaluations", &string(candidate, "evaluation")?)?;
    if binding["check_phase"] != "final"
        || evaluation["guided"] != binding
        || view["steps"].as_array().is_none_or(|steps| {
            steps
                .iter()
                .take(3)
                .any(|step| step["status"] != "complete")
        })
        || view["steps"][2]["candidate_id"] != candidate["id"]
        || view["working_revision"] != candidate["revision"]
    {
        return Err(Error::new(
            "GUIDED_NOT_PUBLISHABLE",
            "Complete final checks and the verified guide chain before publishing",
        ));
    }
    Ok(())
}
const PROFILE: &str = yoneda_core::guided::PROFILE_ID;
const STEPS: [&str; 4] = ["build", "extend", "concurrent", "review"];
pub(super) fn guard(c: &Value) -> Result<()> {
    if !["guided_session", "start_guided_step", "context_get"]
        .contains(&c["op"].as_str().unwrap_or_default())
        && (c["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("guide-session:"))
            || c["record"]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("guide-session:")))
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Guided session identities are platform-owned",
        ));
    }
    Ok(())
}
fn owner(c: &Value) -> Result<()> {
    if ["job_id", "_grant", "_reviewer"]
        .iter()
        .any(|key| c.get(key).is_some())
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Only an ordinary workspace owner controls a guide",
        ));
    }
    Ok(())
}
fn identity(c: &Value) -> Result<String> {
    let id = c
        .get("session_id")
        .or_else(|| c.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| bad("Guided session identity required"))?;
    if !id.strip_prefix("guide-session:").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 120
            && suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    }) || c.get("id").is_some_and(|other| other != id)
        || c.get("profile_id")
            .is_some_and(|profile| profile != PROFILE)
        || c.get("version")
            .is_some_and(|version| !yoneda_core::guided::supported_version(version))
    {
        return Err(bad("Invalid guided session/profile identity"));
    }
    Ok(id.into())
}
fn mismatch() -> Error {
    Error::new(
        "GUIDED_VERSION_MISMATCH",
        "Guided session differs from the project's starter version",
    )
}
/// The profile version the repository was created with. Guided repositories without a
/// project marker predate versioning and are version 1.
fn repository_version(r: &Value) -> Result<Value> {
    let version = match &r["guided_project"] {
        Value::Null => json!(1),
        marker => marker["version"].clone(),
    };
    if !yoneda_core::guided::supported_version(&version) {
        return Err(mismatch());
    }
    Ok(version)
}
/// A session keeps the version, briefs and proofs of the project it was created for.
fn load<S: SqlStore>(db: &S, id: &str) -> Result<Value> {
    match get(db, "nodes", id) {
        Ok(node) if node["kind"] == "guided_session" && node["author"] == "platform" => {
            if node["data"]["version"] != repository_version(&repo(db)?)? {
                return Err(mismatch());
            }
            Ok(node["data"].clone())
        }
        Ok(_) => Err(Error::new(
            "FORBIDDEN",
            "Guided session is not a platform record",
        )),
        Err(e) if e.code == "NOT_FOUND" => {
            let r = repo(db)?;
            Ok(
                json!({"session_id":id,"profile_id":PROFILE,"version":repository_version(&r)?,"policy_digest":yoneda_core::fingerprint(&r["policy"])? ,"root_commit":r["published_commit"],"root_version":r["version"],"working_branch_id":format!("guide-{}",&yoneda_core::digest(id.as_bytes())[..24]),"steps":STEPS.iter().map(|id|json!({"id":id,"run_ids":[]})).collect::<Vec<_>>(),"requests":{}}),
            )
        }
        Err(e) => Err(e),
    }
}
fn save_session<S: SqlStore>(db: &S, session: &Value, now: i64) -> Result<()> {
    node(
        db,
        &string(session, "session_id")?,
        "guided_session",
        "Task board guide",
        "platform",
        now,
        session.clone(),
    )
}
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    owner(c)?;
    let id = identity(c)?;
    let session = load(db, &id)?;
    if c.get("version")
        .is_some_and(|version| *version != session["version"])
    {
        return Err(mismatch());
    }
    match string(c, "op")?.as_str() {
        "guided_session" => evidence::view(db, &session),
        "start_guided_step" => start::execute(db, c, session, now),
        _ => Err(bad("Unknown guide operation")),
    }
}
