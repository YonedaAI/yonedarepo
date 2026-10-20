//! Optional source tooling uses the same container-scoped API as the lazy filesystem.
use crate::{err, source_client_api::source_operation};
use serde_json::Value;
use yoneda_agents_core::{Error, Result};
const TOOLS: &str = include_str!("source_tools.json");
const READ_ONLY: &[&str] = &[
    "source_status",
    "source_list",
    "source_stat",
    "source_read",
    "source_events",
];

pub(crate) fn tools(comparison: bool) -> Result<Vec<Value>> {
    let mut tools: Vec<Value> = serde_json::from_str(TOOLS).map_err(err)?;
    if comparison {
        tools.retain(|tool| READ_ONLY.contains(&tool["name"].as_str().unwrap_or_default()));
    }
    Ok(tools)
}

pub(crate) async fn call(params: Value, comparison: bool) -> Result<Value> {
    let name = params["name"]
        .as_str()
        .ok_or_else(|| invalid("Source tool is missing"))?;
    if comparison && !READ_ONLY.contains(&name) {
        return Err(invalid("Reviewers cannot modify source"));
    }
    let (mount, args) = arguments(params["arguments"].clone())?;
    let name = name.to_owned();
    tokio::task::spawn_blocking(move || source_operation(&mount, &name, args))
        .await
        .map_err(err)?
}
fn arguments(mut value: Value) -> Result<(String, Value)> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| invalid("Source arguments must be an object"))?;
    let mount = match object.remove("mount") {
        None => "repo".to_owned(),
        Some(Value::String(alias))
            if ["repo", "candidate-0", "candidate-1"].contains(&alias.as_str()) =>
        {
            alias
        }
        _ => return Err(invalid("Source mount is not approved")),
    };
    if object.keys().any(|key| {
        key.starts_with('_')
            || [
                "actor",
                "workspace_id",
                "repo_id",
                "job_id",
                "epoch",
                "supervisor",
                "token",
                "authorization",
            ]
            .contains(&key.as_str())
    }) {
        return Err(invalid("Source authority comes from the platform"));
    }
    Ok((mount, value))
}
fn invalid(message: &str) -> Error {
    Error::new("FORBIDDEN", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn review_tools_cannot_offer_mutations_or_private_capabilities() {
        let offered = tools(true).unwrap();
        assert_eq!(offered.len(), READ_ONLY.len());
        for tool in offered {
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
            assert!(READ_ONLY.contains(&tool["name"].as_str().unwrap()));
        }
        assert!(tools(false).unwrap().iter().all(|t| {
            !["source_seal", "source_bind", "source_init", "source_gc_due"]
                .contains(&t["name"].as_str().unwrap())
        }));
    }
    #[test]
    fn source_tool_arguments_cannot_replace_container_identity() {
        for field in [
            "_actor",
            "workspace_id",
            "repo_id",
            "job_id",
            "epoch",
            "token",
            "supervisor",
        ] {
            assert!(arguments(json!({field:"forged"})).is_err());
        }
        assert!(arguments(json!({"mount":"foreign"})).is_err());
        assert_eq!(
            arguments(json!({"mount":"candidate-0","path":"src/a.rs"})).unwrap(),
            ("candidate-0".into(), json!({"path":"src/a.rs"}))
        );
    }
}
