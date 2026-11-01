//! The deploy ledger: one row per deploy or rollback (commit, times, environment, who), kept in
//! the environment's Superfan ledger, so a finding can be tied to a release and a release compared
//! with the one before it. Written when the work ends, good or bad: a failed deploy may still have
//! moved some Workers. The row is a record, not a gate, so nothing here can fail a deploy. Superfan
//! ignores a row it already has, which makes the repeat safe.
//!
//! `who` stays in that ledger: it never reaches wrangler's arguments, so no log can show it.
use crate::deploy_live::public_address;
use crate::infra::inventory::{self, Deployable};
use crate::infra::secrets;
use crate::infra::spec::{Env, Spec};
use serde::Serialize;
use std::net::SocketAddr;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TOKEN: &str = "SUPERFAN_READ_TOKEN";
const WHO_LIMIT: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Deploy,
    Rollback,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Outcome {
    Ok,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Entry {
    pub revision: String,
    pub env: String,
    pub who: String,
    pub kind: Kind,
    pub outcome: Outcome,
    /// Epoch milliseconds: when the first Worker began to change, and when the work ended.
    pub started_at: u64,
    pub finished_at: u64,
}

impl Entry {
    pub(crate) fn new(env: &Env, revision: &str, kind: Kind, ok: bool, started_at: u64) -> Self {
        Self {
            revision: revision.to_owned(),
            env: env.name(),
            who: who(),
            kind,
            outcome: if ok { Outcome::Ok } else { Outcome::Failed },
            started_at,
            finished_at: now_ms(),
        }
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// A deploy's Cloudflare version tag: the short commit (Cloudflare keeps 25 characters).
pub(crate) fn tag(head: &str) -> &str {
    crate::deploy_guard::short(head)
}

/// A deploy's Cloudflare version message (Cloudflare keeps 100 bytes): the environment and the
/// whole commit, and nothing a public log should not show.
pub(crate) fn message(env: &Env, head: &str) -> String {
    format!("{} {head}", env.name())
}

fn who() -> String {
    let name = Command::new("git")
        .args(["config", "user.name"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned());
    who_from(std::env::var("GITHUB_ACTOR").ok(), name)
}

/// The Actions actor on a runner, else the checkout's Git name. Never an address: the part
/// before an `@`, in the characters Superfan accepts.
fn who_from(actor: Option<String>, name: Option<String>) -> String {
    let (prefix, raw) = match (actor.filter(|a| !a.is_empty()), name) {
        (Some(actor), _) => ("github:", actor),
        (None, Some(name)) => ("", name),
        (None, None) => ("", String::new()),
    };
    let clean: String = raw
        .split('@')
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || " ._-".contains(*c))
        .take(WHO_LIMIT - prefix.len())
        .collect();
    match clean.trim() {
        "" => "unknown".to_owned(),
        trimmed => format!("{prefix}{trimmed}"),
    }
}

/// The environment's Superfan, when it has one (an ephemeral stack does not).
fn superfan_origin(spec: &Spec, workers: &[Deployable]) -> Option<String> {
    let worker = workers.iter().find(|w| w.role == "superfan")?;
    inventory::health_origin(spec, &worker.config)
}

/// Sends the row; a failure says so and goes no further.
pub(crate) async fn record(spec: &Spec, workers: &[Deployable], entry: &Entry) {
    let Some(origin) = superfan_origin(spec, workers) else {
        return;
    };
    let token = secrets::read(&spec.secrets_path())
        .ok()
        .and_then(|mut values| values.remove(TOKEN));
    let Some(token) = token else {
        println!("WARNING: deploy ledger not written: no {TOKEN} in the secrets file.");
        return;
    };
    match send(&origin, &token, entry).await {
        Ok(()) => println!("Deploy ledger: written."),
        Err(why) => println!("WARNING: deploy ledger not written ({why})."),
    }
}

/// One try, and one more over 1.1.1.1 when it could not connect: see `deploy_live::live_revision`.
async fn send(origin: &str, token: &str, entry: &Entry) -> Result<(), String> {
    match post(origin, token, entry, None).await {
        Err(Failure::Connect(why)) => match public_address(origin).await {
            Some(address) => post(origin, token, entry, Some(address)).await,
            None => Err(Failure::Connect(why)),
        },
        other => other,
    }
    .map_err(|failure| match failure {
        Failure::Connect(why) | Failure::Refused(why) => why,
    })
}

enum Failure {
    Connect(String),
    Refused(String),
}

async fn post(
    origin: &str,
    token: &str,
    entry: &Entry,
    address: Option<SocketAddr>,
) -> Result<(), Failure> {
    let mut client = reqwest::Client::builder().timeout(Duration::from_secs(15));
    if let (Some(address), Some(host)) = (address, crate::deploy_live::host_of(origin)) {
        client = client.resolve(host, address);
    }
    let client = client
        .build()
        .map_err(|error| Failure::Connect(error.without_url().to_string()))?;
    let answer = client
        .post(format!("{origin}/deploys"))
        .bearer_auth(token)
        .json(entry)
        .send()
        .await
        .map_err(|error| Failure::Connect(error.without_url().to_string()))?;
    if answer.status().is_success() {
        Ok(())
    } else {
        Err(Failure::Refused(format!("HTTP {}", answer.status())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn a_version_names_its_commit_within_cloudflares_limits() {
        assert_eq!(tag(HEAD), "0123456789ab");
        assert!(tag(HEAD).len() <= 25);
        assert_eq!(message(&Env::Prod, HEAD), format!("prod {HEAD}"));
        assert!(message(&Env::Prod, HEAD).len() <= 100);
    }

    #[test]
    fn who_is_the_actor_or_the_git_name_and_never_an_address() {
        let some = |text: &str| Some(text.to_owned());
        assert_eq!(who_from(some("octocat"), some("Ada")), "github:octocat");
        assert_eq!(who_from(None, some("Ada Lovelace")), "Ada Lovelace");
        assert_eq!(who_from(some(""), some("Ada")), "Ada");
        assert_eq!(who_from(None, some("ada@example.com")), "ada");
        assert_eq!(who_from(None, None), "unknown");
        assert_eq!(who_from(None, some("@@")), "unknown");
        assert_eq!(who_from(some(&"a".repeat(99)), None).len(), WHO_LIMIT);
    }

    #[test]
    fn a_row_serializes_as_superfan_reads_it() {
        let entry = Entry {
            revision: HEAD.into(),
            env: "dev".into(),
            who: "Ada".into(),
            kind: Kind::Rollback,
            outcome: Outcome::Failed,
            started_at: 1,
            finished_at: 2,
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            serde_json::json!({
                "revision": HEAD, "env": "dev", "who": "Ada", "kind": "rollback",
                "outcome": "failed", "started_at": 1, "finished_at": 2,
            })
        );
    }
}
