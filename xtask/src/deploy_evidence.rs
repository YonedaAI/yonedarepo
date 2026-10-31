//! The real-world kit evidence a prod deploy needs. Decisions are pure functions over gathered
//! facts, like the rest of deploy_guard.
use crate::deploy_guard::{Facts, Options, short, tree_of};
use crate::infra::inventory;
use crate::infra::spec::{Env, Lock, Spec};
use crate::process::Result;
use serde_json::Value;
use std::path::Path;

/// Real-world kit evidence, newest first: `.local/staging/realworld*.json`.
pub(crate) const EVIDENCE_DIR: &str = ".local/staging";

/// What a full kit run records: every item except those that run only when named
/// (tools/staging-realworld.mjs, `wanted`).
pub(crate) const FULL_KIT: [&str; 22] = [
    "0", "browser", "31", "6", "7", "19", "20", "23", "25", "8", "9", "10", "12", "13", "14", "15",
    "16", "18", "21", "27", "28", "17",
];

/// The kit's browser gate (tools/staging/browser-flow.mjs). Like every item in the evidence, it
/// must pass when present; while the kit can still run without it, its absence is allowed.
/// Set to true once every kit run records it.
pub(crate) const BROWSER_ITEM: &str = "browser";
const BROWSER_REQUIRED: bool = false;

/// The newest evidence is a full kit that passed at exactly HEAD, recording HEAD's tree: what a
/// `live-tests` status claims.
pub(crate) fn full_kit_passes(facts: &Facts) -> Result<()> {
    let at_head = Facts {
        trees: Default::default(),
        ..facts.clone()
    };
    evidence_passes(facts.evidence.as_ref(), &at_head)?;
    let evidence = facts.evidence.as_ref().ok_or("No kit evidence")?;
    if evidence["tree"].as_str().is_none() {
        return Err(
            "Refusing: the newest kit evidence records no tree. Run the full kit again.".into(),
        );
    }
    let items = evidence["items"].as_array().ok_or("No kit items")?;
    let missing: Vec<&str> = FULL_KIT
        .into_iter()
        .filter(|id| !items.iter().any(|item| item["id"] == *id))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Refusing: the newest kit evidence is not a full kit (no item {}). Run `node tools/staging-realworld.mjs`.",
        missing.join(", ")
    )
    .into())
}

/// The commits item 0 saw live.
fn evidence_revisions(evidence: &Value) -> Vec<String> {
    let items = evidence["items"].as_array().into_iter().flatten();
    items
        .filter(|item| item["id"] == "0")
        .flat_map(|item| [&item["metrics"]["front"], &item["metrics"]["platform"]])
        .filter_map(|revision| revision.as_str().map(str::to_owned))
        .collect()
}

/// The kit must have run against this code, HEAD or a commit of HEAD's tree, and passed every
/// item it lists: item 0 (live revisions) always, the browser item whenever it is present.
/// A tree the evidence records (older evidence has none) must be HEAD's too.
pub(crate) fn evidence_passes(evidence: Option<&Value>, facts: &Facts) -> Result<()> {
    let evidence = evidence.ok_or(
        "Refusing prod: no real-world kit evidence in .local/staging/. Run `node tools/staging-realworld.mjs` against dev.",
    )?;
    let items = evidence["items"]
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or("Refusing prod: kit evidence lists no items.")?;
    let revisions = items.iter().find(|item| item["id"] == "0").map(|item| {
        (
            item["metrics"]["front"].as_str(),
            item["metrics"]["platform"].as_str(),
        )
    });
    let tested = |revision: Option<&str>| revision.is_some_and(|r| facts.same_code(r));
    let recorded = evidence["tree"].as_str();
    if !revisions.is_some_and(|(front, platform)| tested(front) && tested(platform))
        || recorded.is_some_and(|tree| tree != facts.head_tree)
    {
        return Err(format!(
            "Refusing prod: the newest kit evidence was not recorded against HEAD {} or its tree (item 0 revisions: {revisions:?}, tree: {recorded:?}).",
            short(&facts.head)
        )
        .into());
    }
    if BROWSER_REQUIRED && !items.iter().any(|item| item["id"] == BROWSER_ITEM) {
        return Err(format!(
            "Refusing prod: the newest kit evidence has no {BROWSER_ITEM} item. Run the kit with --browser."
        )
        .into());
    }
    if let Some(item) = items.iter().find(|item| item["status"] != "pass") {
        return Err(format!(
            "Refusing prod: kit item {} ({}) is {}, not pass.",
            item["id"].as_str().unwrap_or("?"),
            item["title"].as_str().unwrap_or(""),
            item["status"].as_str().unwrap_or("missing")
        )
        .into());
    }
    Ok(())
}

/// The most recently modified `realworld*.json` evidence file, parsed.
pub(crate) fn newest_evidence(dir: &Path) -> Result<Option<Value>> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(None);
    };
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("realworld") && name.ends_with(".json")) {
            continue;
        }
        let modified = entry.metadata()?.modified()?;
        if newest.as_ref().is_none_or(|(time, _)| modified > *time) {
            newest = Some((modified, entry.path()));
        }
    }
    match newest {
        Some((_, path)) => Ok(Some(
            serde_json::from_slice(&std::fs::read(&path)?)
                .map_err(|error| format!("Invalid kit evidence {}: {error}", path.display()))?,
        )),
        None => Ok(None),
    }
}

/// The facts only a prod deploy needs: the dev Workers' revisions, the newest kit evidence and
/// the trees of the commits they name; from a merged ship PR, its head's GitHub statuses.
pub(crate) async fn prod_facts(facts: &mut Facts, options: &Options) -> Result<()> {
    if let Some(head) = &options.ship_head {
        facts.ship = Some(crate::deploy_ship::gather(head).await?);
        return Ok(());
    }
    let dev = Spec::load(&Env::Dev)?;
    for worker in inventory::deployables(&dev, &Lock::load(&Env::Dev)?)? {
        if worker.health.is_some() {
            facts.dev_revisions.push((
                worker.name.clone(),
                crate::deploy_live::live_revision(&worker).await,
            ));
        }
    }
    facts.evidence = newest_evidence(Path::new(EVIDENCE_DIR))?;
    let live = facts.dev_revisions.iter().filter_map(|(_, r)| r.clone());
    let tested = facts.evidence.iter().flat_map(evidence_revisions);
    let commits: Vec<String> = live.chain(tested).collect();
    for commit in commits {
        if let Some(tree) = tree_of(&commit) {
            facts.trees.insert(commit, tree);
        }
    }
    Ok(())
}
