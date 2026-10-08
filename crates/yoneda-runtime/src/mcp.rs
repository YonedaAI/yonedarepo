use crate::{broker::broker, err};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use yoneda_core::Result;
pub const TOOLS: &str = include_str!("mcp_tools.json");

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
            "tools/list" => Ok(json!({"tools":serde_json::from_str::<Value>(TOOLS).map_err(err)?})),
            "tools/call" => match broker("/mcp", request["params"].clone(), false).await {
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
