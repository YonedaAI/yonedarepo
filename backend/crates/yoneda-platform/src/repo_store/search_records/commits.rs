//! The commits group: matches of a commit's message and recorder (`commit_text`), of a
//! path it touched (`commit_path_text`) and of its id, merged by commit and ranked.
use super::{CANDIDATES, RESTRICTED_CANDIDATES, Request, SHOWN, shown, text};
use crate::repo_store::grants::{self, Grant};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::collections::{BTreeSet, HashMap};
use yoneda_core::Result;

/// One candidate commit, by id.
struct Found {
    row: Value,
    paths: BTreeSet<String>,
    by_id: bool,
}

pub(super) fn commits<S: SqlStore>(db: &S, req: &Request, grant: &Grant) -> Result<Value> {
    const COLUMNS: &str = "c.rowid AS seq,c.id,c.message,c.principal,c.recorded_at";
    let mut found: HashMap<String, Found> = HashMap::new();
    let mut capped = false;
    let texts = req.matches(
        db,
        &format!(
            "SELECT {COLUMNS} FROM commit_text t JOIN commits c ON c.rowid=t.rowid \
             WHERE commit_text MATCH ? ORDER BY t.rowid DESC LIMIT ?"
        ),
        CANDIDATES,
    )?;
    capped |= texts.len() == CANDIDATES;
    for row in texts {
        found.entry(text(&row, "id").to_owned()).or_insert(Found {
            row,
            paths: BTreeSet::new(),
            by_id: false,
        });
    }
    let by_path = req.matches(
        db,
        &format!(
            "SELECT {COLUMNS},p.path FROM commit_path_text t JOIN commit_paths p ON p.rowid=t.rowid \
             JOIN commits c ON c.id=p.commit_id WHERE commit_path_text MATCH ? \
             ORDER BY t.rowid DESC LIMIT ?"
        ),
        CANDIDATES,
    )?;
    capped |= by_path.len() == CANDIDATES;
    for row in by_path {
        let path = text(&row, "path").to_owned();
        if !grants::allows(grant, &path) {
            continue;
        }
        found
            .entry(text(&row, "id").to_owned())
            .or_insert(Found {
                row: row.clone(),
                paths: BTreeSet::new(),
                by_id: false,
            })
            .paths
            .insert(path);
    }
    if let Some(prefix) = &req.id_prefix {
        let upper = format!("{prefix}g");
        for row in db.query(
            &format!(
                "SELECT {COLUMNS} FROM commits c WHERE c.id>=? AND c.id<? ORDER BY c.id LIMIT ?"
            ),
            &[json!(prefix), json!(upper), json!(SHOWN)],
        )? {
            found
                .entry(text(&row, "id").to_owned())
                .or_insert(Found {
                    row,
                    paths: BTreeSet::new(),
                    by_id: false,
                })
                .by_id = true;
        }
    }
    let mut candidates: Vec<(String, Found)> = found.into_iter().collect();
    // Newest first, so a restricted token's bounded check keeps the newest.
    candidates.sort_by_key(|(id, f)| (Reverse(f.row["seq"].as_i64().unwrap_or(0)), id.clone()));
    if grant.is_some() && candidates.len() > RESTRICTED_CANDIDATES {
        candidates.truncate(RESTRICTED_CANDIDATES);
        capped = true;
    }
    let mut ranked = Vec::new();
    for (id, f) in candidates {
        // The paths a result shows, and a restricted token's test: it must touch the grant.
        let touched = || -> Result<Vec<String>> {
            Ok(db
                .query(
                    "SELECT path FROM commit_paths WHERE commit_id=? ORDER BY path LIMIT ?",
                    &[json!(id), json!(CANDIDATES)],
                )?
                .iter()
                .map(|r| text(r, "path").to_owned())
                .filter(|p| grants::allows(grant, p))
                .collect())
        };
        let paths = if grant.is_some() {
            let allowed = touched()?;
            if allowed.is_empty() {
                continue;
            }
            Some(allowed)
        } else {
            None
        };
        let message = text(&f.row, "message").to_owned();
        let subject = message.lines().next().unwrap_or_default().to_owned();
        let mut matched = Vec::new();
        let mut score = 0;
        for (name, hit, points) in [
            ("id", f.by_id, 16),
            ("subject", req.holds(&subject), 8),
            ("message", req.holds(&message), 4),
            ("author", req.holds(text(&f.row, "principal")), 2),
            ("paths", !f.paths.is_empty(), 1),
        ] {
            if hit {
                matched.push(name);
                score += points;
            }
        }
        let seq = f.row["seq"].as_i64().unwrap_or(0);
        ranked.push((
            (score, f.row["recorded_at"].as_i64().unwrap_or(0), seq),
            (id, f, subject, matched, paths),
        ));
    }
    // Paths are read only for the results shown.
    ranked.sort_by_key(|(key, _)| Reverse(*key));
    let count = ranked.len();
    let mut results = Vec::new();
    for (_, (id, f, subject, matched, paths)) in ranked.into_iter().take(req.limit) {
        let paths = match paths {
            Some(paths) => paths,
            None => db
                .query(
                    "SELECT path FROM commit_paths WHERE commit_id=? ORDER BY path LIMIT ?",
                    &[json!(id), json!(CANDIDATES)],
                )?
                .iter()
                .map(|r| text(r, "path").to_owned())
                .collect(),
        };
        results.push(json!({
            "commit": id, "subject": subject, "principal": f.row["principal"],
            "recorded_at": f.row["recorded_at"], "matched": matched,
            "paths": shown(paths, |p| f.paths.contains(p)),
        }));
    }
    Ok(json!({ "count": count, "capped": capped, "results": results }))
}
