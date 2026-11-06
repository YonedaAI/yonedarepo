//! Refs in the store as the authority holds them. The authority is the truth: after each
//! push, and on start (a crash may fall between its commit and the ref update), every
//! branch and tag is moved there with its old value as the lease. A store ref naming
//! something the authority never recorded was written outside the service and is left
//! alone, loudly, rather than overwritten.
use crate::service::{PROJECTOR, Service};
use serde_json::json;
use std::collections::HashMap;
use yoneda_core::{Result, git_object::ObjectId};

pub fn project(svc: &Service) -> Result<()> {
    let _projecting = svc.projecting.lock().unwrap_or_else(|e| e.into_inner());
    let listed = svc
        .authority
        .call(&PROJECTOR, json!({ "op": "repo_refs" }))?;
    let mut want: HashMap<String, ObjectId> = HashMap::new();
    for (name, id) in listed["refs"].as_object().into_iter().flatten() {
        if !(name.starts_with("refs/heads/") || name.starts_with("refs/tags/")) {
            continue;
        }
        // An annotated tag's ref names its tag object, as Git expects.
        let shown = listed["annotated"][name].as_str().or(id.as_str());
        want.insert(name.clone(), ObjectId::parse(shown.unwrap_or_default())?);
    }
    let have = svc.store.refs()?;
    for (name, id) in &want {
        let current = have.get(name).copied();
        if current == Some(*id) {
            continue;
        }
        // A staged merge not yet drained into the store: the push that drains it moves it.
        if !svc.store.has(id) {
            continue;
        }
        if current.is_none_or(|c| recorded(svc, &c)) {
            svc.store.update_ref(name, Some(*id), current)?;
        } else {
            eprintln!("yoneda-local: {name} was changed outside the service; left as is");
        }
    }
    for (name, current) in &have {
        if !want.contains_key(name) && recorded(svc, current) {
            svc.store.update_ref(name, None, Some(*current))?;
        }
    }
    Ok(())
}

/// Whether the authority recorded commit `id` (so the store ref holding it is its own).
fn recorded(svc: &Service, id: &ObjectId) -> bool {
    svc.authority
        .call(
            &PROJECTOR,
            json!({ "op": "repo_commit", "commit": id, "brief": true }),
        )
        .is_ok()
}
