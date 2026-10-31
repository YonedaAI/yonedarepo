//! What an erase deletes and how much of it fits a transaction. The list is explicit, so the
//! tombstone's rows are safe from it, and a test fails on any table it does not account for.
//!
//! A full-text table's deletes only mark its index: the terms stay, as many bytes as ever,
//! until a merge rewrites it, and a merge of deleted terms writes nothing and so ignores its
//! page budget, clearing the whole index in one transaction (measured: 4 MB per 200k paths).
//! In `secure-delete` mode each delete takes its terms out of the index itself, so the row
//! budget bounds that work too, and only empty pages are left for the last step's rebuild.
use super::{BYTE_BUDGET, ROW_BUDGET};
use crate::storage::SqlStore;
use serde_json::Value;
use yoneda_core::Result;

pub(crate) struct Table {
    pub(crate) name: &'static str,
    /// The column to walk: `rowid`, or a `WITHOUT ROWID` table's primary key.
    key: &'static str,
    /// The columns that can hold large values. Other columns count as nothing: they are
    /// short, and the row budget bounds them.
    large: &'static [&'static str],
}

const fn rows(name: &'static str) -> Table {
    sized(name, &[])
}
const fn sized(name: &'static str, large: &'static [&'static str]) -> Table {
    Table {
        name,
        key: "rowid",
        large,
    }
}
const fn keyed(name: &'static str, key: &'static str) -> Table {
    Table {
        name,
        key,
        large: &[],
    }
}

/// Every table but the tombstone's: `repo_settings` and `repo_schema_migrations`. Full-text
/// tables are listed for rows no trigger removes: `memory_text` has none, and the others'
/// rows go with `commits`, `commit_paths`, `sessions` and `changes`.
pub(crate) const TABLES: &[Table] = &[
    rows("annotated_tags"),
    rows("bisects"),
    rows("break_glass"),
    sized("change_comments", &["body"]),
    sized("changes", &["title", "body"]),
    sized("changesets", &["message"]),
    rows("check_runs"),
    rows("checks"),
    rows("commit_classes"),
    rows("commit_objects"),
    sized("commit_paths", &["path"]),
    rows("commit_symbols"),
    sized("commits", &["message", "read_set"]),
    sized("context_deliveries", &["items"]),
    keyed("bundled_objects", "id"),
    keyed("fork_origin", "refname"),
    keyed("forks", "repo"),
    rows("hook_attempts"),
    rows("hook_cursor"),
    sized("hook_outbox", &["payload"]),
    rows("hooks"),
    rows("land_leases"),
    sized("land_queue", &["result"]),
    rows("landings"),
    rows("lfs_objects"),
    rows("lfs_orphans"),
    rows("lfs_quota"),
    rows("lfs_sweep"),
    rows("members"),
    sized("memories", &["body"]),
    rows("memory_anchors"),
    rows("memory_retirements"),
    rows("mirror_copied"),
    rows("mirror_retirement"),
    rows("object_outbox_dispatch"),
    rows("object_projections"),
    rows("pins"),
    rows("policy_history"),
    sized("prepared_commits", &["payload"]),
    rows("quarantine"),
    rows("ref_chain"),
    rows("ref_projections"),
    rows("refs"),
    rows("release_assets"),
    sized("releases", &["notes"]),
    rows("repairs"),
    rows("reviews"),
    sized("sessions", &["summary", "transcript"]),
    sized("staged_objects", &["data_b64"]),
    rows("symbol_contracts"),
    rows("tokens"),
    sized("tree_cache", &["data_b64"]),
    sized("txlog", &["entry"]),
    rows("txlog_anchor"),
    rows("txlog_checkpoints"),
    rows("txlog_paths"),
    rows("txlog_retention"),
    rows("txlog_segments"),
    sized("commit_text", &["message"]),
    sized("commit_path_text", &["path"]),
    sized("session_text", &["summary", "reads"]),
    sized("change_text", &["title", "body"]),
    sized("memory_text", &["body"]),
];

const INDEXES: [&str; 5] = [
    "commit_text",
    "commit_path_text",
    "session_text",
    "change_text",
    "memory_text",
];

/// Rows read from a table at a time while measuring.
const PAGE: usize = 64;

#[derive(Default)]
pub(super) struct Spent {
    pub rows: u32,
    pub bytes: u64,
    /// Every table is empty.
    pub finished: bool,
}

impl Spent {
    fn exhausted(&self) -> bool {
        self.rows >= ROW_BUDGET || self.bytes >= u64::from(BYTE_BUDGET)
    }
}

/// How far into `table` this transaction's budget reaches: the last key, and `spent` grown
/// by what is up to it. Reads a page at a time, so a table of large values is not read
/// whole to delete a few of its rows.
fn measure<S: SqlStore>(db: &S, table: &Table, spent: &mut Spent) -> Result<Option<Value>> {
    let size = match table.large {
        [] => "0".to_owned(),
        columns => columns
            .iter()
            .map(|c| format!("COALESCE(LENGTH({c}),0)"))
            .collect::<Vec<_>>()
            .join("+"),
    };
    let (name, key) = (table.name, table.key);
    let mut last: Option<Value> = None;
    loop {
        let (from, after) = match &last {
            Some(key_value) => (format!("WHERE {key}>?"), vec![key_value.clone()]),
            None => (String::new(), Vec::new()),
        };
        let page = db.query(
            &format!(
                "SELECT {key} AS k,{size} AS n FROM {name} {from} ORDER BY {key} LIMIT {PAGE}"
            ),
            &after,
        )?;
        let full = page.len() == PAGE;
        for row in page {
            spent.rows += 1;
            spent.bytes += row["n"].as_u64().unwrap_or(0);
            last = Some(row["k"].clone());
            if spent.exhausted() {
                return Ok(last);
            }
        }
        if !full {
            return Ok(last);
        }
    }
}

/// One transaction's worth: deletes rows under the budgets, table by table.
pub(super) fn batch<S: SqlStore>(db: &S) -> Result<Spent> {
    for index in INDEXES {
        db.query(
            &format!("INSERT INTO {index}({index},rank) VALUES('secure-delete',1)"),
            &[],
        )?;
    }
    let mut spent = Spent::default();
    for table in TABLES {
        if let Some(last) = measure(db, table, &mut spent)? {
            db.query(
                &format!("DELETE FROM {} WHERE {}<=?", table.name, table.key),
                &[last],
            )?;
        }
        if spent.exhausted() {
            return Ok(spent);
        }
    }
    spent.finished = spent.rows == 0;
    Ok(spent)
}

/// Clears what the deletes left in the now empty indexes: empty pages.
pub(super) fn reset_indexes<S: SqlStore>(db: &S) -> Result<()> {
    for index in INDEXES {
        db.query(
            &format!("INSERT INTO {index}({index}) VALUES('rebuild')"),
            &[],
        )?;
    }
    Ok(())
}
