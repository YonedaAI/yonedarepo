//! `repo_change_route {number}`: a change's route in one bounded read, from this database
//! alone: the commits it introduces, the coding sessions behind them, what those sessions
//! were shown and the checks recorded on them. The range is the diff's: the head less what
//! its merge bases with the base reach, a landed change's base read just before it landed.
//! A route describes whole commits, so a path-restricted token reads none of it, as with
//! `repo_change_show`; sessions and delivered items read masked under quarantine. Every list
//! keeps its newest rows up to a cap and `truncated` says which were cut. Tokens per coding
//! session aren't recorded, so `read_bytes` is the cost measure.
use super::auth::Actor;
use super::changes::{self, number_of, whole_repository};
use super::memory::deliveries;
use super::rows::{self, corrupt};
use super::{agent_reads, quarantine, reads, session_range, sessions};
use crate::storage::SqlStore;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, merge_bases},
};

const MAX_COMMITS: usize = 500;
const MAX_SESSIONS: usize = 200;
const MAX_DELIVERIES: usize = 500;
const MAX_CHECKS: usize = 500;
/// Bytes of a commit message read for its subject.
const SUBJECT_BYTES: u32 = 300;

/// A change's commits and the evidence on them (`GET /changes/:n/route`).
#[derive(Debug, Serialize, JsonSchema)]
pub struct ChangeRoute {
    pub number: i64,
    /// `open`, `closed` or `landed`.
    pub status: String,
    pub branch: String,
    pub base: String,
    /// The change's head commit (null once its branch is gone).
    pub head: Option<String>,
    /// Where the change left its base (null: unrelated histories, or no head).
    pub merge_base: Option<String>,
    /// Newest first.
    pub commits: Vec<RouteCommit>,
    /// Session records on those commits, newest first.
    pub sessions: Vec<RouteSession>,
    /// What those coding sessions were shown, oldest first.
    pub deliveries: Vec<RouteDelivery>,
    /// The latest verdict per commit and check name, newest first.
    pub checks: Vec<RouteCheck>,
    pub totals: RouteTotals,
    pub truncated: RouteTruncated,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct RouteCommit {
    pub commit: String,
    pub parents: Vec<String>,
    /// The commit message's first line.
    pub subject: String,
    pub principal: String,
    /// When the platform recorded it (Unix milliseconds).
    pub at: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RouteSession {
    pub id: i64,
    pub commit: String,
    pub cli: String,
    pub model: Option<String>,
    /// Null while the record is quarantined (or after its purge).
    pub summary: Option<String>,
    /// The coding session's own id; null on older records.
    pub session_id: Option<String>,
    pub recorded_by: String,
    pub at: i64,
    /// Bytes the session's clone fetched so far; null when not reported.
    pub fetched_bytes: Option<u64>,
    /// Bytes of the files its agent read so far; null when not reported.
    pub read_bytes: Option<u64>,
    /// The repository's owner withholds this record's text.
    #[serde(default)]
    pub quarantined: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RouteDelivery {
    pub seq: i64,
    pub session_id: String,
    /// `start`, `read` or `prompt`.
    pub trigger: String,
    /// The file read, or a prompt's SHA-256.
    pub subject: Option<String>,
    pub bytes: u64,
    pub principal: String,
    pub at: i64,
    pub items: Vec<RouteDeliveredItem>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RouteDeliveredItem {
    /// `memory`, `contract`, `session`, `change` or `traffic`.
    #[serde(rename = "type")]
    pub kind: String,
    pub id: i64,
    /// The item's current text; null for what quarantine withholds.
    pub label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct RouteCheck {
    pub commit: String,
    pub name: String,
    /// `pass` or `fail`.
    pub status: String,
    pub principal: String,
    pub at: i64,
}

/// Over the lists as returned. A coding session's byte tallies are cumulative, so each counts
/// once, at its highest.
#[derive(Debug, Default, Serialize, JsonSchema)]
pub struct RouteTotals {
    pub commits: u64,
    /// Coding sessions (a record without a session id is its own).
    pub sessions: u64,
    pub read_bytes: u64,
    pub fetched_bytes: u64,
    pub delivered_bytes: u64,
    /// Distinct memories delivered.
    pub memories_delivered: u64,
}

/// Which lists stopped at their cap (`commits`: or the walk from the head did).
#[derive(Debug, Serialize, JsonSchema)]
pub struct RouteTruncated {
    pub commits: bool,
    pub sessions: bool,
    pub deliveries: bool,
    pub checks: bool,
}

fn decoded<T: DeserializeOwned>(value: Value, what: &str) -> Result<T> {
    serde_json::from_value(value).map_err(|_| corrupt(what))
}

/// `SQL` over `ids`, at most `max` rows, and whether there were more.
fn capped<S: SqlStore>(db: &S, sql: &str, ids: &Value, max: usize) -> Result<(Vec<Value>, bool)> {
    let mut rows = db.query(sql, &[json!(ids.to_string()), json!(max + 1)])?;
    let cut = rows.len() > max;
    rows.truncate(max);
    Ok((rows, cut))
}

/// The base branch's commit the change is measured against: where it stands now, or just
/// before a landed change reached it.
fn base_tip<S: SqlStore>(db: &S, change: &Value) -> Result<Option<ObjectId>> {
    let base = change["base"].as_str().unwrap_or_default();
    let refname = format!("refs/heads/{base}");
    match change["landed_version"].as_u64() {
        Some(version) if change["status"] == "landed" => {
            let before = version.saturating_sub(1);
            reads::ref_at(db, &json!({ "at": before }), before, &refname)
        }
        _ => rows::projected_ref(db, &refname),
    }
}

/// `id` when it is recorded here: a commit graph can only be walked from one that is.
fn recorded<S: SqlStore>(db: &S, id: Option<ObjectId>) -> Result<Option<ObjectId>> {
    Ok(match id {
        Some(id) if rows::commit_row(db, &id)?.is_some() => Some(id),
        _ => None,
    })
}

fn commits<S: SqlStore>(db: &S, ids: &Value) -> Result<(Vec<RouteCommit>, bool)> {
    let (found, cut) = capped(
        db,
        &format!(
            "SELECT id,parents,principal,recorded_at,substr(message,1,{SUBJECT_BYTES}) AS message \
             FROM commits WHERE id IN (SELECT value FROM json_each(?1)) \
             ORDER BY generation DESC,recorded_at DESC,id LIMIT ?2"
        ),
        ids,
        MAX_COMMITS,
    )?;
    let listed = found.iter().map(|row| {
        Ok(RouteCommit {
            commit: decoded(row["id"].clone(), "commit id")?,
            parents: serde_json::from_str(row["parents"].as_str().unwrap_or("[]"))
                .map_err(|_| corrupt("parents"))?,
            subject: agent_reads::subject(&row["message"]),
            principal: decoded(row["principal"].clone(), "principal")?,
            at: decoded(row["recorded_at"].clone(), "commit time")?,
        })
    });
    Ok((listed.collect::<Result<_>>()?, cut))
}

fn session_records<S: SqlStore>(db: &S, ids: &Value) -> Result<(Vec<RouteSession>, bool)> {
    let (mut found, cut) = capped(
        db,
        "SELECT id,commit_id AS \"commit\",cli,model,summary,session_id,recorded_by,at,\
         fetched_bytes,read_bytes FROM sessions \
         WHERE commit_id IN (SELECT value FROM json_each(?1)) ORDER BY id DESC LIMIT ?2",
        ids,
        MAX_SESSIONS,
    )?;
    quarantine::mask_sessions(db, &mut found)?;
    let listed = found.into_iter().map(|mut row| {
        row["model"] = sessions::shown_model(&row["model"]);
        decoded(row, "session record")
    });
    Ok((listed.collect::<Result<_>>()?, cut))
}

/// The latest verdict per commit and name (a policy change can leave several).
fn checks<S: SqlStore>(db: &S, ids: &Value) -> Result<(Vec<RouteCheck>, bool)> {
    let (found, cut) = capped(
        db,
        "SELECT commit_id AS \"commit\",name,status,principal,recorded_at AS at FROM checks \
         WHERE commit_id IN (SELECT value FROM json_each(?1)) \
         ORDER BY recorded_at DESC,commit_id,name LIMIT ?2",
        ids,
        MAX_CHECKS,
    )?;
    let mut seen = HashSet::new();
    let mut latest = Vec::new();
    for row in found {
        let check: RouteCheck = decoded(row, "check")?;
        if seen.insert((check.commit.clone(), check.name.clone())) {
            latest.push(check);
        }
    }
    Ok((latest, cut))
}

fn totals(
    commits: &[RouteCommit],
    records: &[RouteSession],
    delivered: &[RouteDelivery],
) -> RouteTotals {
    let mut highest: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for record in records {
        let key = match &record.session_id {
            Some(id) => id.clone(),
            None => format!("record:{}", record.id),
        };
        let tally = highest.entry(key).or_default();
        tally.0 = tally.0.max(record.read_bytes.unwrap_or(0));
        tally.1 = tally.1.max(record.fetched_bytes.unwrap_or(0));
    }
    let memories: BTreeSet<i64> = delivered
        .iter()
        .flat_map(|d| &d.items)
        .filter(|item| item.kind == "memory")
        .map(|item| item.id)
        .collect();
    RouteTotals {
        commits: commits.len() as u64,
        sessions: highest.len() as u64,
        read_bytes: highest.values().map(|t| t.0).sum(),
        fetched_bytes: highest.values().map(|t| t.1).sum(),
        delivered_bytes: delivered.iter().map(|d| d.bytes).sum(),
        memories_delivered: memories.len() as u64,
    }
}

pub fn route<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let change = changes::get(db, number_of(c)?)?;
    let head = change["head"].as_str().map(ObjectId::parse).transpose()?;
    let head = recorded(db, head)?;
    let bases = match (head, recorded(db, base_tip(db, &change)?)?) {
        (Some(head), Some(tip)) => merge_bases(&rows::RecordedGraph(db), &tip, &head)?,
        _ => Vec::new(),
    };
    let range = session_range::between(db, head, &bases)?;
    let ids = json!(range.commits);
    let (commits, more_commits) = commits(db, &ids)?;
    let shown = json!(commits.iter().map(|c| &c.commit).collect::<Vec<_>>());
    let (records, more_sessions) = session_records(db, &shown)?;
    let coding: BTreeSet<&String> = records.iter().flat_map(|r| &r.session_id).collect();
    let coding: Vec<&str> = coding.into_iter().map(String::as_str).collect();
    let (delivered, more_deliveries) = deliveries::of_sessions(db, &coding, MAX_DELIVERIES)?;
    let delivered: Vec<RouteDelivery> = decoded(json!(delivered), "delivery")?;
    let (checks, more_checks) = checks(db, &shown)?;
    let route = ChangeRoute {
        number: decoded(change["number"].clone(), "change number")?,
        status: decoded(change["status"].clone(), "change status")?,
        branch: decoded(change["branch"].clone(), "change branch")?,
        base: decoded(change["base"].clone(), "change base")?,
        head: decoded(change["head"].clone(), "change head")?,
        merge_base: bases.first().map(ObjectId::hex),
        totals: totals(&commits, &records, &delivered),
        truncated: RouteTruncated {
            commits: range.truncated || more_commits,
            sessions: more_sessions,
            deliveries: more_deliveries,
            checks: more_checks,
        },
        commits,
        sessions: records,
        deliveries: delivered,
        checks,
    };
    serde_json::to_value(route).map_err(|e| Error::new("ENCODING", e.to_string()))
}
