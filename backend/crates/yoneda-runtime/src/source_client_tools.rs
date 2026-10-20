//! Native MCP bridge to the same container-derived SourceWorkspace API, never a second authority.
use super::{
    ApiSourceClient,
    http::{SourceHttp, WireRequest},
};
use crate::source_client::{SOURCE_READ_MAX, failure};
use base64::Engine;
use serde_json::{Value, json};
use yoneda_agents_core::Result;
const PUBLIC: &[&str] = &[
    "source_upload",
    "source_status",
    "source_list",
    "source_stat",
    "source_read",
    "source_create",
    "source_write",
    "source_truncate",
    "source_delete",
    "source_chmod",
    "source_copy",
    "source_rename",
    "source_checkpoint",
    "source_events",
];
/// Parent dispatches only source_* tools here; alias comes from the approved mount enum.
pub fn source_operation(alias: &str, operation: &str, arguments: Value) -> Result<Value> {
    if !PUBLIC.contains(&operation) {
        return Err(failure("FORBIDDEN", "Source operation is not public"));
    }
    validate_arguments(&arguments)?;
    let http = SourceHttp::new(alias)?;
    let result = http.send(if operation == "source_upload" {
        upload_request(arguments)?
    } else {
        WireRequest::Json {
            op: operation.into(),
            args: arguments,
            supervisor: None,
        }
    })?;
    if operation == "source_read" {
        Ok(
            json!({"metadata":result.value,"encoding":"base64","bytes":base64::engine::general_purpose::STANDARD.encode(result.bytes)}),
        )
    } else {
        Ok(result.value)
    }
}
impl ApiSourceClient {
    /// Frozen client equivalent used by scoped native integrations and protocol tests.
    pub fn tool(&self, operation: &str, arguments: Value) -> Result<Value> {
        if !PUBLIC.contains(&operation) {
            return Err(failure("FORBIDDEN", "Source operation is not public"));
        }
        validate_arguments(&arguments)?;
        if operation == "source_upload" {
            if self.read_only {
                return Err(failure("SOURCE_READ_ONLY", "Source view is read-only"));
            }
            return Ok(self.http.send(upload_request(arguments)?)?.value);
        }
        if operation != "source_read" {
            return self.operation(operation, arguments);
        }
        use crate::source_client::SourceBackend;
        let path = arguments["path"]
            .as_str()
            .ok_or_else(|| failure("INVALID_SOURCE", "Source path missing"))?;
        let version = arguments["expected_file_version"]
            .as_u64()
            .ok_or_else(|| failure("INVALID_SOURCE", "Source file version missing"))?;
        let offset = arguments["offset"].as_u64().unwrap_or(0);
        let length = arguments["limit"]
            .as_u64()
            .unwrap_or(SOURCE_READ_MAX as u64);
        let length = usize::try_from(length)
            .map_err(|_| failure("SOURCE_LIMIT", "Invalid source read length"))?;
        let slice = self.read(path, version, offset, length)?;
        Ok(
            json!({"path":path,"file_version":slice.version,"offset":slice.offset,"encoding":"base64","bytes":base64::engine::general_purpose::STANDARD.encode(slice.bytes)}),
        )
    }
}
fn validate_arguments(args: &Value) -> Result<()> {
    let object = args
        .as_object()
        .ok_or_else(|| failure("INVALID_SOURCE", "Source arguments must be an object"))?;
    if object.keys().any(|key| {
        key.starts_with('_')
            || [
                "workspace_id",
                "repo_id",
                "job_id",
                "epoch",
                "actor",
                "supervisor",
                "token",
                "authorization",
            ]
            .contains(&key.as_str())
    }) {
        return Err(failure(
            "FORBIDDEN",
            "Source identity is derived by the platform",
        ));
    }
    Ok(())
}

fn upload_request(args: Value) -> Result<WireRequest> {
    let object = args
        .as_object()
        .ok_or_else(|| failure("INVALID_SOURCE", "Source upload arguments missing"))?;
    if object.keys().any(|key| {
        ![
            "request_id",
            "path",
            "mode",
            "content_base64",
            "expected_workspace_version",
            "expected_file_version",
        ]
        .contains(&key.as_str())
    }) {
        return Err(failure("INVALID_SOURCE", "Unknown source upload field"));
    }
    let text = |key: &str| {
        args[key]
            .as_str()
            .ok_or_else(|| failure("INVALID_SOURCE", "Source upload field missing"))
    };
    let encoded = text("content_base64")?;
    if encoded.len() > SOURCE_READ_MAX.div_ceil(3) * 4 {
        return Err(failure("SOURCE_LIMIT", "MCP source upload exceeds 64 KiB"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| failure("INVALID_SOURCE", "Invalid source upload base64"))?;
    if bytes.len() > SOURCE_READ_MAX {
        return Err(failure("SOURCE_LIMIT", "MCP source upload exceeds 64 KiB"));
    }
    let path = text("path")?;
    crate::source_client::validate_path(path, false)?;
    let mode = text("mode")?;
    if !["100644", "100755"].contains(&mode) {
        return Err(failure("INVALID_SOURCE", "Invalid source mode"));
    }
    let id = text("request_id")?.to_string();
    yoneda_agents_core::source_workspace::validate_id(&id)?;
    let mut query = vec![
        ("path".into(), path.into()),
        ("mode".into(), mode.into()),
        ("sha256".into(), yoneda_agents_core::digest(&bytes)),
        ("size".into(), bytes.len().to_string()),
    ];
    for key in ["expected_workspace_version", "expected_file_version"] {
        let version = args[key]
            .as_u64()
            .filter(|version| *version <= 9_007_199_254_740_991)
            .ok_or_else(|| failure("INVALID_SOURCE", "Source upload CAS missing"))?;
        query.push((key.into(), version.to_string()));
    }
    Ok(WireRequest::Upload {
        request_id: id,
        query,
        bytes,
    })
}
