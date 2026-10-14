use crate::{broker::broker, err};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use yoneda_core::Result;
pub const TOOLS: &str = include_str!("mcp_tools.json");
const COMPARISON_TOOLS: &str = include_str!("comparison_tools.json");

pub async fn mcp() -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(err)? {
        if line.len() > 1024 * 1024 {
            return Err(err("MCP message too large"));
        }
        let request: Value = serde_json::from_str(&line).map_err(err)?;
        if request.get("id").is_none() {
            continue;
        }
        let result = match request["method"].as_str().unwrap_or_default() {
            "initialize" => Ok(
                json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"yonedarepo","version":"0.1.0"}}),
            ),
            "ping" => Ok(json!({})),
            "tools/list" => tool_list(),
            "tools/call" => match call(request["params"].clone()).await {
                Ok(value) => Ok(json!({"content":[{"type":"text","text":value.to_string()}]})),
                Err(error) => {
                    Ok(json!({"isError":true,"content":[{"type":"text","text":error.to_string()}]}))
                }
            },
            _ => Err(err("Unknown MCP method")),
        };
        let response = match result {
            Ok(result) => json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
            Err(error) => {
                json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":error.to_string()}})
            }
        };
        stdout
            .write_all(format!("{response}\n").as_bytes())
            .await
            .map_err(err)?;
        stdout.flush().await.map_err(err)?;
    }
    Ok(())
}

fn tool_list() -> Result<Value> {
    let comparison = std::env::var("YONEDA_COMPARISON_REVIEW").as_deref() == Ok("1");
    let mut tools: Vec<Value> =
        serde_json::from_str(if comparison { COMPARISON_TOOLS } else { TOOLS }).map_err(err)?;
    if std::env::var("YONEDA_SOURCE_API").as_deref() == Ok("1") {
        tools.extend(crate::source_mcp::tools(comparison)?);
    }
    Ok(json!({"tools":tools}))
}

async fn call(params: Value) -> Result<Value> {
    if params["name"]
        .as_str()
        .is_some_and(|name| name.starts_with("source_"))
    {
        if std::env::var("YONEDA_SOURCE_API").as_deref() != Ok("1") {
            return Err(yoneda_core::Error::new(
                "FORBIDDEN",
                "Source tooling is unavailable for this attempt",
            ));
        }
        return crate::source_mcp::call(
            params,
            std::env::var("YONEDA_COMPARISON_REVIEW").as_deref() == Ok("1"),
        )
        .await;
    }
    broker("/mcp", params, false).await
}
