//! Isolated operator trials keep retrieval corpus separate from assigned model input.
use crate::storage::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{Error, Result, context_study::ContextStudy};

fn parse(value: &Value) -> Result<ContextStudy> {
    let study: ContextStudy =
        serde_json::from_value(value.clone()).map_err(|e| bad(&e.to_string()))?;
    study.validate()?;
    if !study.records.is_empty() {
        return Err(bad(
            "Study records are resolved by the server from corpus IDs",
        ));
    }
    let distinct: BTreeSet<_> = study.corpus.iter().collect();
    if distinct.len() != study.corpus.len() {
        return Err(bad("Study corpus IDs must be unique"));
    }
    Ok(study)
}

pub(super) fn initialize(c: &Value, repository: &mut Value) -> Result<()> {
    if let Some(value) = c.get("context_study") {
        let study = parse(value)?;
        repository["context_study"] =
            serde_json::to_value(study).map_err(|_| bad("Invalid study"))?;
    }
    Ok(())
}

pub(super) fn freeze<S: SqlStore>(db: &S, repository: &Value) -> Result<Option<Value>> {
    let Some(value) = repository.get("context_study") else {
        return Ok(None);
    };
    let mut input = value.clone();
    input["records"] = json!([]);
    let mut study = parse(&input)?;
    for id in &study.corpus {
        study.records.push(get(db, "nodes", id)?);
    }
    study.validate()?;
    Ok(Some(
        serde_json::to_value(study).map_err(|_| bad("Invalid frozen study"))?,
    ))
}

pub(super) fn configure<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let mut repository = repo(db)?;
    if repository["workspace"] != c["_workspace"] || c.get("_grant").is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the repository owner may configure disposable context trials",
        ));
    }
    if !db
        .query(
            "SELECT id FROM runs WHERE json_type(payload,'$.context_study')='object' LIMIT 1",
            &[],
        )?
        .is_empty()
    {
        return Err(Error::new(
            "INVALID_STATE",
            "Study configuration is frozen after the first trial run",
        ));
    }
    if !repository["pending"].is_null() || !db.query("SELECT id FROM jobs WHERE json_extract(payload,'$.status') IN ('queued','running') LIMIT 1", &[])?.is_empty() {
        return Err(Error::new("RUN_ACTIVE", "Finish or cancel active work before configuring a context trial"));
    }
    initialize(&c, &mut repository)?;
    repository["context_study"] =
        freeze(db, &repository)?.ok_or_else(|| bad("Study configuration is required"))?;
    save(db, "repository", "repo", &repository)?;
    event(
        db,
        "context_study.configured",
        now,
        json!({"id":repository["context_study"]["id"],"arm":repository["context_study"]["arm"]}),
    )?;
    Ok(repository["context_study"].clone())
}

pub(super) fn apply(run: &mut Value, study: Option<Value>) {
    if let Some(study) = study {
        run["context"] = json!([]);
        run["context_records"] = json!([]);
        run["context_study"] = study;
    }
}
