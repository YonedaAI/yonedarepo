//! Access decisions from a published head (stateless compute): a commit begins and a read
//! is authorized in the Worker without an authority round trip, by the same rules the
//! authority applies, over the head's access snapshot. A stale snapshot can only admit
//! work the landing then re-checks against the authority's current access.
use crate::repo_store::auth::{Actor, actor_with};
use crate::repo_store::grants;
use crate::repo_store::members::Role;
use crate::storage::{bad, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

fn actor(c: &Value) -> Result<Actor> {
    let head = &c["head"];
    let credentials = &c["credentials"];
    // Only client credentials: platform roles call the authority itself.
    if credentials.get("_system").is_some() {
        return Err(Error::new("FORBIDDEN", "Platform roles use the authority"));
    }
    let tokens = head["tokens"]
        .as_array()
        .ok_or_else(|| bad("The head carries no access snapshot"))?;
    // A head published before members carries none: members are then refused here and
    // the authority decides.
    let members = head["members"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    actor_with(
        credentials,
        &string(head, "workspace")?,
        // A head published before visibility carries none: private.
        head["visibility"] == "public",
        |digest| Ok(tokens.iter().find(|t| t["digest"] == digest).cloned()),
        |account| {
            members
                .iter()
                .find(|m| m["account"] == account)
                .map(|m| Role::parse(m["role"].as_str().unwrap_or_default()))
                .transpose()
        },
    )
}

/// `head_begin`: authorizes a commit on the published head and names its parent and base.
pub fn head_begin(c: &Value) -> Result<Value> {
    let actor = actor(c)?;
    actor.require("write")?;
    for path in c["paths"].as_array().into_iter().flatten() {
        grants::require(&actor.grant, path.as_str().unwrap_or_default())?;
    }
    let head = &c["head"];
    Ok(json!({
        "principal": actor.principal, "parent": head["head"], "parent_id": head["head"]["id"],
        "parent_elsewhere": false, "base_version": head["base_version"],
        "object_store": head["object_store"], "runners": head["runners"],
    }))
}

/// `head_access`: the caller's read access (principal, directory grant, and whether it
/// reads only because the repository is public).
pub fn head_access(c: &Value) -> Result<Value> {
    let actor = actor(c)?;
    actor.require("read")?;
    Ok(json!({
        "principal": actor.principal, "owner": actor.owner, "grant": actor.grant,
        "public": actor.public,
    }))
}
