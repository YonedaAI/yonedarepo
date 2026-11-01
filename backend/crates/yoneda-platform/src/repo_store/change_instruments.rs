//! `repo_change_instruments {number}`: what the authority knows about a change's last heads,
//! for its Slop and Risk cards: each head's check values, the review classes of the commits it
//! would bring, its open findings and the tree its diff compares against. Bounded: at most
//! `HEADS` heads, `land_gates::WALK` commits each and `CHECKS` results per head. The adapter
//! measures the diffs and `platform_instruments` makes the answer. Read from check evidence, which
//! anyone who can read the change can read, and only ever a validated value from it. Computed
//! from existing rows; nothing is stored.
use super::auth::Actor;
use super::changes::{self, number_of, whole_repository};
use super::land_gates::walk_until;
use super::rows::{self, CommitRow};
use crate::platform_instruments::{
    ChangeFacts, CheckReading, CheckValue, CommitFacts, Compared, HeadFacts,
};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, merge_bases},
    txlog::TxEntry,
};

/// Heads one read covers.
const HEADS: usize = 5;
/// Branch moves read to find them (a branch can move back and forth over the same commits).
const MOVES: u64 = 32;
/// Check results read per head, newest first: more than a repository's checks in practice.
const CHECKS: u64 = 64;

/// A move of the branch: `None` when it deleted the branch.
fn moves<S: SqlStore>(db: &S, change: &Value) -> Result<Vec<(Option<ObjectId>, i64)>> {
    let branch = change["branch"].as_str().unwrap_or_default();
    // Only this change's own moves: past an earlier change landed from the same branch, and
    // up to this one's landing when it landed.
    let floor = db.query(
        "SELECT COALESCE(MAX(landed_version),0) AS v FROM changes WHERE branch=? AND number<?",
        &[json!(branch), change["number"].clone()],
    )?;
    let ceiling = change["landed_version"].as_i64().unwrap_or(i64::MAX);
    db.query(
        "SELECT entry FROM txlog WHERE refname=? AND version>? AND version<=? \
         ORDER BY version DESC LIMIT ?",
        &[
            json!(format!("refs/heads/{branch}")),
            floor[0]["v"].clone(),
            json!(ceiling),
            json!(MOVES),
        ],
    )?
    .iter()
    .map(|row| {
        let entry: TxEntry = serde_json::from_str(row["entry"].as_str().unwrap_or_default())
            .map_err(|_| rows::corrupt("log entry"))?;
        Ok((entry.new, entry.committed_at_ms))
    })
    .collect()
}

/// The change's head and the distinct commits its branch held before, newest first, each with
/// when the branch moved to it.
fn last_heads<S: SqlStore>(db: &S, change: &Value, head: ObjectId) -> Result<Vec<(ObjectId, i64)>> {
    let moved = moves(db, change)?;
    let at = |id: ObjectId| moved.iter().find(|(new, _)| *new == Some(id)).map(|m| m.1);
    let updated = change["updated_at"].as_i64().unwrap_or(0);
    let mut heads = vec![(head, at(head).unwrap_or(updated))];
    for (new, when) in &moved {
        // Before a deletion, the branch was something else.
        let Some(id) = new else { break };
        if heads.len() == HEADS {
            break;
        }
        if heads.iter().all(|(seen, _)| seen != id) {
            heads.push((*id, *when));
        }
    }
    Ok(heads)
}

/// The commit the change compares against: the base's tip, or for a landed change the tip
/// just before it landed (null if the log has archived it or the base is gone).
fn base_tip<S: SqlStore>(db: &S, change: &Value) -> Result<Option<ObjectId>> {
    let refname = format!("refs/heads/{}", change["base"].as_str().unwrap_or_default());
    let Some(landed) = change["landed_version"].as_i64() else {
        return rows::projected_ref(db, &refname);
    };
    let before = db.query(
        "SELECT entry FROM txlog WHERE refname=? AND version<? ORDER BY version DESC LIMIT 1",
        &[json!(refname), json!(landed)],
    )?;
    let Some(row) = before.first() else {
        return Ok(None);
    };
    let entry: TxEntry = serde_json::from_str(row["entry"].as_str().unwrap_or_default())
        .map_err(|_| rows::corrupt("log entry"))?;
    Ok(entry.new)
}

/// The classes of the commits `commit` brings over `bases`. Like semantic approval, a merge, a
/// parent not recorded or a walk past its bound proves nothing, so it is reported `unread`.
fn commit_facts<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    bases: &[ObjectId],
) -> Result<CommitFacts> {
    if bases.contains(&commit.id) {
        return Ok(CommitFacts::default());
    }
    let facts = RefCell::new(CommitFacts::default());
    let tally = |id: &ObjectId| -> Result<bool> {
        let class = db.query(
            "SELECT overall FROM commit_classes WHERE commit_id=?",
            &[json!(id.hex())],
        )?;
        let mut facts = facts.borrow_mut();
        match class.first().and_then(|r| r["overall"].as_str()) {
            Some(overall) => *facts.classes.entry(overall.to_owned()).or_default() += 1,
            None => facts.unclassified += 1,
        }
        Ok(true)
    };
    tally(&commit.id)?;
    let read = walk_until(db, commit, |parent| Ok(bases.contains(parent)), tally)?;
    let mut facts = facts.into_inner();
    facts.unread = !read;
    Ok(facts)
}

/// The newest result per check that names a value, and the findings they withheld.
fn check_readings<S: SqlStore>(db: &S, id: &ObjectId) -> Result<(Vec<CheckReading>, u64)> {
    let rows = db.query(
        "SELECT name,evidence,recorded_at FROM checks WHERE commit_id=? \
         ORDER BY recorded_at DESC LIMIT ?",
        &[json!(id.hex()), json!(CHECKS)],
    )?;
    let mut seen = HashSet::new();
    let mut readings = Vec::new();
    let mut withheld = 0u64;
    for row in &rows {
        let name = row["name"].as_str().unwrap_or_default();
        if !seen.insert(name) {
            continue;
        }
        // Evidence is the poster's text: read a known value or nothing.
        let evidence: Value = row["evidence"]
            .as_str()
            .and_then(|e| serde_json::from_str(e).ok())
            .unwrap_or(Value::Null);
        for severity in ["high", "medium", "low"] {
            let count = evidence["withheld"][severity].as_u64().unwrap_or(0);
            withheld = withheld.saturating_add(count);
        }
        if let Ok(value) = serde_json::from_value::<CheckValue>(evidence["value"].clone()) {
            readings.push(CheckReading {
                name: name.to_owned(),
                value,
                recorded_at: row["recorded_at"].as_i64().unwrap_or(0),
            });
        }
    }
    Ok((readings, withheld))
}

/// Unresolved comments on lines of the change, per commit.
fn open_comments<S: SqlStore>(db: &S, number: &Value) -> Result<HashMap<String, u64>> {
    let rows = db.query(
        "SELECT commit_id,COUNT(*) AS n FROM change_comments WHERE change_number=? \
         AND path IS NOT NULL AND resolved_at IS NULL GROUP BY commit_id",
        std::slice::from_ref(number),
    )?;
    Ok(rows
        .iter()
        .filter_map(|r| Some((r["commit_id"].as_str()?.to_owned(), r["n"].as_u64()?)))
        .collect())
}

/// One head's facts: `tip` is what it compares against, `comments` its unresolved ones.
fn head_facts<S: SqlStore>(
    db: &S,
    row: &CommitRow,
    at: i64,
    tip: Option<ObjectId>,
    comments: u64,
) -> Result<HeadFacts> {
    let bases = match tip {
        Some(tip) => Some(merge_bases(&rows::RecordedGraph(db), &row.id, &tip)?),
        None => None,
    };
    let compared = match bases.as_deref() {
        Some([base, ..]) => Some(Compared {
            base_tree: Some(rows::recorded(db, base)?.tree.hex()),
        }),
        Some([]) => Some(Compared { base_tree: None }),
        None => None,
    };
    let commits = match &bases {
        Some(bases) => commit_facts(db, row, bases)?,
        None => CommitFacts::default(),
    };
    let (checks, withheld) = check_readings(db, &row.id)?;
    Ok(HeadFacts {
        commit: row.id.hex(),
        tree: row.tree.hex(),
        at,
        compared,
        commits,
        open_findings: withheld.saturating_add(comments),
        checks,
    })
}

pub fn read<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let change = changes::get(db, number_of(c)?)?;
    let mut heads = Vec::new();
    if let Some(head) = change["head"].as_str() {
        let tip = base_tip(db, &change)?;
        let open = open_comments(db, &change["number"])?;
        let last = last_heads(db, &change, ObjectId::parse(head)?)?;
        for (n, (id, at)) in last.into_iter().enumerate() {
            // A commit a forced move left behind can be gone since.
            let Some(row) = rows::commit_row(db, &id)? else {
                continue;
            };
            // The newest head answers for every comment still open; an older one for its own.
            let comments = match n {
                0 => open.values().sum(),
                _ => open.get(&id.hex()).copied().unwrap_or(0),
            };
            heads.push(head_facts(db, &row, at, tip, comments)?);
        }
    }
    let facts = ChangeFacts {
        number: change["number"].as_i64().unwrap_or_default(),
        heads,
    };
    serde_json::to_value(facts).map_err(|e| Error::new("ENCODING", e.to_string()))
}
