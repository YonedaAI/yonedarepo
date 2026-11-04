//! Validated branch and tag names; read selectors never relax write selectors.
use crate::storage::{bad, string};
use serde_json::Value;
use yoneda_core::Result;

/// Protected refs (Scion: refs only for main and releases) move only by landing an
/// approved, checked commit (or the human break-glass path), never by a working-branch
/// compare-and-swap; they are also the refs projected to the Git object store.
pub fn protected(refname: &str) -> bool {
    refname == "refs/heads/main"
        || refname == "refs/heads/release"
        || refname.starts_with("refs/heads/release/")
}

/// Accepts `main` or `refs/heads/main`; only branch refs are writable through the API.
pub fn branch_ref(c: &Value) -> Result<String> {
    let name = string(c, "ref")?;
    let full = if name.starts_with("refs/") {
        name
    } else {
        format!("refs/heads/{name}")
    };
    if !valid_name(full.strip_prefix("refs/heads/").unwrap_or_default()) {
        return Err(bad("Invalid branch name"));
    }
    Ok(full)
}

/// Accepts `v1` or `refs/tags/v1`: a lightweight tag (created once, never moved).
pub fn tag_ref(name: &str) -> Result<String> {
    let full = if name.starts_with("refs/") {
        name.to_owned()
    } else {
        format!("refs/tags/{name}")
    };
    if !valid_name(full.strip_prefix("refs/tags/").unwrap_or_default()) {
        return Err(bad("Invalid tag name"));
    }
    Ok(full)
}

pub fn is_tag(refname: &str) -> bool {
    refname.starts_with("refs/tags/")
}

/// Git's ref-name rules for a branch or tag name below its `refs/<kind>/` prefix.
fn valid_name(name: &str) -> bool {
    !(name.is_empty()
        || name.len() > 200
        || name
            .split('/')
            .any(|p| p.is_empty() || p.starts_with('.') || p.ends_with(".lock"))
        || name.contains(|ch: char| ch.is_ascii_control() || " ~^:?*[\\".contains(ch))
        || name.contains("..")
        || name.contains("@{"))
}

/// Read selectors accept explicit tags as well as short or fully qualified branches.
/// Writes keep using `branch_ref`, so accepting a tag here never permits moving it.
pub fn read_ref(c: &Value) -> Result<String> {
    let name = string(c, "ref")?;
    if name.starts_with("refs/tags/") {
        tag_ref(&name)
    } else {
        branch_ref(c)
    }
}
