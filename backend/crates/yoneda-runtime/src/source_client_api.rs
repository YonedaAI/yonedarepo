//! Exact frozen-source API projection, independent of FUSE and provider credentials.
#[path = "source_client_constructors.rs"]
mod constructors;
#[path = "source_client_http.rs"]
mod http;
#[path = "source_client_mutations.rs"]
mod mutations;
#[path = "source_client_tools.rs"]
mod tools;
use crate::source_client::{
    SOURCE_READ_MAX, SourceBackend, SourceChange, SourceNode, SourceSlice, failure,
};
use http::{SourceHttp, WireRequest};
use serde_json::{Value, json};
use std::sync::Arc;
pub fn source_operation(alias: &str, operation: &str, arguments: Value) -> Result<Value> {
    tools::source_operation(alias, operation, arguments)
}
use yoneda_core::Result;

pub struct ApiSourceClient {
    http: Arc<SourceHttp>,
    expected_workspace: String,
    expected_view: String,
    read_only: bool,
}
impl ApiSourceClient {
    pub fn status(&self) -> Result<Value> {
        let status = self.http.command("source_status", json!({}))?;
        if status["version"] != 1
            || status["capabilities"]["source_api"] != 1
            || status["transport"] != "api-source-v1"
            || status["workspace_id"] != self.expected_workspace
            || status["view_digest"] != self.expected_view
            || status["authority"] != "staged_source"
            || status["checked"] != false
            || status["published"] != false
            || status["access"]
                != if self.read_only {
                    "read_only"
                } else {
                    "read_write"
                }
            || !["open", "sealed"]
                .iter()
                .any(|state| status["status"] == *state)
        {
            return Err(failure(
                "SOURCE_FENCED",
                "Source mount identity or readiness changed",
            ));
        }
        integer(&status, "workspace_version")?;
        Ok(status)
    }
    fn stat_value(&self, path: &str, version: Option<u64>) -> Result<Value> {
        let mut args = http::args(path);
        if let Some(version) = version {
            args["expected_workspace_version"] = json!(version);
        }
        self.http.command("source_stat", args)
    }
    /// Ordinary public tooling cannot call supervisor seal or private domain operations.
    pub fn operation(&self, operation: &str, arguments: Value) -> Result<Value> {
        if ![
            "source_status",
            "source_list",
            "source_stat",
            "source_create",
            "source_write",
            "source_truncate",
            "source_delete",
            "source_chmod",
            "source_copy",
            "source_rename",
            "source_checkpoint",
            "source_events",
        ]
        .contains(&operation)
        {
            return Err(failure("FORBIDDEN", "Source operation is not public"));
        }
        if self.read_only
            && ![
                "source_status",
                "source_list",
                "source_stat",
                "source_events",
            ]
            .contains(&operation)
        {
            return Err(failure("SOURCE_READ_ONLY", "Source view is read-only"));
        }
        self.http.command(operation, arguments)
    }
    /// Root supervisor only; the capability stays out of model child environments.
    pub fn seal(&self, request_id: &str, supervisor: &str) -> Result<Value> {
        let version = integer(&self.status()?, "workspace_version")?;
        let checkpoint = self.http.command("source_checkpoint", json!({"request_id":format!("{request_id}-checkpoint"),"expected_workspace_version":version}))?;
        let body = json!({"request_id":request_id,"expected_workspace_version":version,
            "checkpoint_id":checkpoint["checkpoint_id"],"expected_checkpoint_digest":checkpoint["changeset_digest"]});
        Ok(self
            .http
            .send(WireRequest::Json {
                op: "source_seal".into(),
                args: body,
                supervisor: Some(supervisor.into()),
            })?
            .value)
    }
}
impl SourceBackend for ApiSourceClient {
    fn stat(&self, path: &str) -> Result<SourceNode> {
        if path.is_empty() {
            return Ok(SourceNode {
                path: "".into(),
                version: integer(&self.status()?, "workspace_version")?,
                mode: 0o040755,
                size: 0,
            });
        }
        node(&self.stat_value(path, None)?)
    }
    fn list(&self, path: &str) -> Result<Vec<SourceNode>> {
        let version = integer(&self.status()?, "workspace_version")?;
        let mut cursor = Value::Null;
        let mut entries = Vec::new();
        loop {
            let page = self.http.command(
                "source_list",
                json!({"prefix":path,"recursive":false,
                "cursor":cursor,"limit":200,"expected_workspace_version":version}),
            )?;
            if page["workspace_id"] != self.expected_workspace
                || page["workspace_version"] != version
            {
                return Err(failure("SOURCE_FENCED", "Source list identity changed"));
            }
            let items = page["items"]
                .as_array()
                .ok_or_else(|| failure("SOURCE_FENCED", "Invalid source list"))?;
            for item in items {
                entries.push(node(item)?);
            }
            if entries.len() > 10_000 {
                return Err(failure("SOURCE_LIMIT", "Source list exceeds its limit"));
            }
            let next = page["next_cursor"].clone();
            if next.is_null() {
                break;
            }
            if !next.is_string() || next == cursor {
                return Err(failure("SOURCE_FENCED", "Invalid source list cursor"));
            }
            cursor = next;
        }
        Ok(entries)
    }
    fn read(&self, path: &str, version: u64, offset: u64, length: usize) -> Result<SourceSlice> {
        if length == 0 || length > SOURCE_READ_MAX {
            return Err(failure("SOURCE_LIMIT", "Invalid source read length"));
        }
        let result = self.http.send(WireRequest::Json { op: "source_read".into(),
            args: json!({"path":path,"expected_file_version":version,"offset":offset,"limit":length}), supervisor: None })?;
        let metadata = &result.value;
        if metadata["workspace_id"] != self.expected_workspace
            || metadata["file"]["path"] != path
            || metadata["file"]["file_version"] != version
            || metadata["offset"] != offset
            || metadata["length"] != result.bytes.len() as u64
            || result.bytes.len() > length
        {
            return Err(failure(
                "SOURCE_FENCED",
                "Source read identity or range changed",
            ));
        }
        Ok(SourceSlice {
            version,
            offset,
            bytes: result.bytes,
        })
    }
    fn apply(&self, request_id: &str, change: &SourceChange) -> Result<Option<SourceNode>> {
        if self.read_only {
            return Err(failure("SOURCE_READ_ONLY", "Source view is read-only"));
        }
        mutations::apply(self, request_id, change)
    }
}
fn node(value: &Value) -> Result<SourceNode> {
    let path = value["path"]
        .as_str()
        .ok_or_else(|| failure("SOURCE_FENCED", "Source path metadata missing"))?
        .to_string();
    if value["kind"] == "missing" && value["exists"] == false {
        return Err(failure("SOURCE_NOT_FOUND", "Source file does not exist"));
    }
    let (mode, size) = if value["kind"] == "directory" {
        (0o040755, 0)
    } else if value["kind"] == "file" {
        (
            match value["mode"].as_str() {
                Some("100644") => 0o100644,
                Some("100755") => 0o100755,
                _ => return Err(failure("SOURCE_FENCED", "Invalid source mode")),
            },
            integer(value, "size")?,
        )
    } else {
        return Err(failure("SOURCE_FENCED", "Invalid source entry kind"));
    };
    if value["exists"] != true {
        return Err(failure("SOURCE_FENCED", "Invalid source entry existence"));
    }
    let result = SourceNode {
        path,
        version: integer(value, "file_version")?,
        mode,
        size,
    };
    result.validate()?;
    Ok(result)
}
fn integer(value: &Value, key: &str) -> Result<u64> {
    value[key]
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| failure("SOURCE_FENCED", "Invalid source integer metadata"))
}
