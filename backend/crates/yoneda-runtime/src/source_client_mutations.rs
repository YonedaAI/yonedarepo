//! Full replacement preparation reads only the one touched file; metadata mutations read no blobs.
use super::{ApiSourceClient, http::WireRequest, integer, node};
use crate::source_client::{
    SOURCE_FILE_MAX, SOURCE_READ_MAX, SourceBackend, SourceChange, SourceNode, failure,
};
use serde_json::{Value, json};
use yoneda_core::Result;

pub(super) fn apply(
    client: &ApiSourceClient,
    id: &str,
    change: &SourceChange,
) -> Result<Option<SourceNode>> {
    let status = client.status()?;
    let workspace_version = integer(&status, "workspace_version")?;
    let current = client.stat_value(change.path(), Some(workspace_version))?;
    let file_version = integer(&current, "file_version")?;
    let expected = match change {
        SourceChange::Create { .. } => file_version,
        SourceChange::Write { expected, .. }
        | SourceChange::Truncate { expected, .. }
        | SourceChange::Delete { expected, .. }
        | SourceChange::Mode { expected, .. }
        | SourceChange::Rename { expected, .. } => *expected,
    };
    if file_version != expected {
        return Err(failure(
            "FILE_VERSION_CONFLICT",
            "Source file version changed",
        ));
    }
    let mut args = json!({"request_id":id,"path":change.path(),"expected_workspace_version":workspace_version,"expected_file_version":file_version});
    let operation = match change {
        SourceChange::Create { mode, .. } => {
            if current["kind"] != "missing" {
                return Err(failure("ALREADY_EXISTS", "Source file already exists"));
            }
            args["ticket_id"] = upload(
                client,
                id,
                change.path(),
                workspace_version,
                file_version,
                *mode,
                Vec::new(),
            )?;
            "source_create"
        }
        SourceChange::Write { offset, bytes, .. } => {
            let entry = node(&current)?;
            let length = offset
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| failure("SOURCE_LIMIT", "Source size overflow"))?
                .max(entry.size);
            if length > SOURCE_FILE_MAX {
                return Err(failure("SOURCE_LIMIT", "Source file exceeds its limit"));
            }
            let mut replacement = contents(client, &entry, entry.size)?;
            replacement.resize(length as usize, 0);
            replacement[*offset as usize..*offset as usize + bytes.len()].copy_from_slice(bytes);
            args["ticket_id"] = upload(
                client,
                id,
                change.path(),
                workspace_version,
                file_version,
                entry.mode,
                replacement,
            )?;
            "source_write"
        }
        SourceChange::Truncate { size, .. } => {
            let entry = node(&current)?;
            if *size > SOURCE_FILE_MAX {
                return Err(failure("SOURCE_LIMIT", "Source file exceeds its limit"));
            }
            let mut replacement = contents(client, &entry, entry.size.min(*size))?;
            replacement.resize(*size as usize, 0);
            args["ticket_id"] = upload(
                client,
                id,
                change.path(),
                workspace_version,
                file_version,
                entry.mode,
                replacement,
            )?;
            args["length"] = json!(size);
            "source_truncate"
        }
        SourceChange::Delete { .. } => "source_delete",
        SourceChange::Mode { mode, .. } => {
            args["mode"] = mode_value(*mode)?;
            "source_chmod"
        }
        SourceChange::Rename {
            target,
            target_expected,
            ..
        } => {
            let target_stat = client.stat_value(target, Some(workspace_version))?;
            let target_version = integer(&target_stat, "file_version")?;
            let exists = target_stat["exists"] == true;
            if target_expected.is_some_and(|expected| expected != target_version)
                || target_expected.is_none() && exists
            {
                return Err(failure(
                    "FILE_VERSION_CONFLICT",
                    "Source destination changed",
                ));
            }
            args = json!({"request_id":id,"from":change.path(),"to":target,"expected_workspace_version":workspace_version,
                "expected_from_version":file_version,"expected_to_version":target_version,"overwrite":exists});
            "source_rename"
        }
    };
    let receipt = client.http.command(operation, args)?;
    if receipt["workspace_id"] != client.expected_workspace
        || receipt["request_id"] != id
        || receipt["authority"] != "staged_source"
        || integer(&receipt, "workspace_version")? != workspace_version + 1
    {
        return Err(failure("SOURCE_FENCED", "Source mutation receipt changed"));
    }
    if receipt["version"] != 1 || receipt["file_versions"][change.path()] != workspace_version + 1 {
        return Err(failure(
            "SOURCE_FENCED",
            "Source mutation path receipt changed",
        ));
    }
    if let SourceChange::Rename { target, .. } = change
        && receipt["file_versions"][target] != workspace_version + 1
    {
        return Err(failure("SOURCE_FENCED", "Source rename receipt changed"));
    }
    if matches!(change, SourceChange::Delete { .. }) {
        return Ok(None);
    }
    let path = if let SourceChange::Rename { target, .. } = change {
        target
    } else {
        change.path()
    };
    // Unrelated concurrent writes must not reinterpret our acknowledged per-file version.
    let after = client.stat_value(path, None)?;
    let result = node(&after)?;
    if result.version != workspace_version + 1 {
        return Err(failure("SOURCE_FENCED", "Source file receipt changed"));
    }
    Ok(Some(result))
}
fn contents(client: &ApiSourceClient, node: &SourceNode, length: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while (bytes.len() as u64) < length {
        let limit = ((length - bytes.len() as u64) as usize).min(SOURCE_READ_MAX);
        let chunk = client.read(&node.path, node.version, bytes.len() as u64, limit)?;
        if chunk.bytes.len() != limit {
            return Err(failure(
                "SOURCE_FENCED",
                "Source replacement read was incomplete",
            ));
        }
        bytes.extend_from_slice(&chunk.bytes);
    }
    Ok(bytes)
}
fn upload(
    client: &ApiSourceClient,
    id: &str,
    path: &str,
    workspace_version: u64,
    file_version: u64,
    mode: u32,
    bytes: Vec<u8>,
) -> Result<Value> {
    let mode = mode_value(mode)?
        .as_str()
        .ok_or_else(|| failure("SOURCE_FENCED", "Source upload mode missing"))?
        .to_string();
    let hash = yoneda_core::digest(&bytes);
    let expected_hash = hash.clone();
    let expected_size = bytes.len() as u64;
    let expected_mode = mode.clone();
    let query = vec![
        ("path".into(), path.into()),
        ("sha256".into(), hash),
        ("size".into(), bytes.len().to_string()),
        ("mode".into(), mode),
        (
            "expected_workspace_version".into(),
            workspace_version.to_string(),
        ),
        ("expected_file_version".into(), file_version.to_string()),
    ];
    let result = client
        .http
        .send(WireRequest::Upload {
            request_id: format!("{id}-upload"),
            query,
            bytes,
        })?
        .value;
    if result["workspace_id"] != client.expected_workspace
        || result["workspace_version"] != workspace_version
        || result["version"] != 1
        || result["authority"] != "staged_source"
        || result["ticket"]["path"] != path
        || result["ticket"]["sha256"] != expected_hash
        || result["ticket"]["size"] != expected_size
        || result["ticket"]["mode"] != expected_mode
        || result["ticket"]["state"] != "verified"
        || !result["ticket"]["id"].is_string()
    {
        return Err(failure(
            "SOURCE_FENCED",
            "Source upload verification changed",
        ));
    }
    Ok(result["ticket"]["id"].clone())
}
fn mode_value(mode: u32) -> Result<Value> {
    match mode {
        0o100644 => Ok(json!("100644")),
        0o100755 => Ok(json!("100755")),
        _ => Err(failure(
            "INVALID_SOURCE",
            "Only regular source files may be uploaded",
        )),
    }
}
