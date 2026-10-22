//! `yoneda sync --attempt <id>`: for contribution keys that cannot land. Pending commits
//! go through the remote MCP `attempt_commit` (onto the attempt's own branch), then
//! `attempt_submit` hands the result to independent evaluation and a human decision.
use crate::changes;
use crate::checkout::Checkout;
use crate::chunk;
use crate::credentials::{Header, Token};
use crate::error::{Error, Result};
use serde_json::{Value, json};

struct Mcp {
    http: reqwest::Client,
    url: String,
    header: Header,
    next_id: u64,
}

impl Mcp {
    /// Calls a tool over stateless Streamable HTTP JSON-RPC; returns its JSON result.
    async fn call(&mut self, name: &str, arguments: Value) -> Result<Value> {
        self.next_id += 1;
        let body = json!({
            "jsonrpc": "2.0", "id": self.next_id, "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        });
        let mut request = self
            .http
            .post(&self.url)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18")
            .json(&body);
        request = match &self.header {
            Header::Authorization(value) => request.header("authorization", value),
            Header::Cookie(value) => request.header("cookie", value),
            Header::None => request,
        };
        let response = request
            .send()
            .await
            .map_err(|e| Error::new(format!("cannot reach the MCP endpoint: {e}")))?;
        let status = response.status().as_u16();
        let reply: Value = response.json().await.map_err(|e| {
            Error::new(format!("{name}: unreadable MCP reply (HTTP {status}): {e}"))
        })?;
        tool_result(name, &reply)
    }
}

/// A `tools/call` reply's JSON value, or the tool's or protocol's error.
pub fn tool_result(name: &str, reply: &Value) -> Result<Value> {
    if let Some(message) = reply["error"]["message"].as_str() {
        return Err(Error::new(format!("{name}: {message}")));
    }
    let result = &reply["result"];
    let text = result["content"][0]["text"].as_str().unwrap_or_default();
    if result["isError"] == true {
        return Err(Error::new(format!("{name}: {text}")));
    }
    serde_json::from_str(text).map_err(|e| Error::new(format!("{name}: unexpected result: {e}")))
}

pub async fn sync(co: &mut Checkout, attempt: &str, mcp_url: Option<&str>) -> Result<()> {
    let token = match std::env::var("YONEDA_MCP_TOKEN")
        .ok()
        .filter(|t| !t.trim().is_empty())
    {
        Some(value) => Token::new(&value)?,
        None => co.token.clone(),
    };
    let url = mcp_url
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{}/mcp/{}", co.state.origin, co.state.repo));
    let http = reqwest::Client::builder()
        .user_agent(concat!("yoneda-cli/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| Error::new(format!("building the HTTP client: {e}")))?;
    let mut mcp = Mcp {
        http,
        url,
        header: token.header(),
        next_id: 0,
    };
    let commits = co.git.first_parent_since(&co.state.local_base)?;
    // Resume after the last commit this attempt already received.
    let done = co
        .state
        .attempts
        .get(attempt)
        .and_then(|last| commits.iter().position(|c| c == last));
    let todo = &commits[done.map_or(0, |i| i + 1)..];
    for local in todo {
        let parent = co.git.first_parent(local)?;
        let message = co.git.authored(local)?.message;
        for part in chunk::chunk(changes::between(&co.git, &parent, local)?, &chunk::ATTEMPT)? {
            let changes: Vec<Value> = part.iter().map(changes::Change::mcp_json).collect();
            let made = mcp
                .call(
                    "attempt_commit",
                    json!({ "attempt_id": attempt, "changes": changes, "message": message }),
                )
                .await?;
            println!(
                "committed {} as {}",
                short(local),
                made["commit"].as_str().unwrap_or("?")
            );
        }
        co.state.attempts.insert(attempt.to_owned(), local.clone());
        co.save()?;
    }
    if commits.is_empty() {
        return Err(Error::new("no local commits to contribute"));
    }
    let submitted = mcp
        .call("attempt_submit", json!({ "attempt_id": attempt }))
        .await?;
    println!(
        "Submitted {attempt}: {} (a human decides on the website)",
        submitted["status"].as_str().unwrap_or("submitted")
    );
    Ok(())
}

fn short(id: &str) -> &str {
    id.get(..12).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tool_results_and_errors() -> Result<()> {
        let ok = json!({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"commit\":\"c\"}"}]}});
        assert_eq!(tool_result("attempt_commit", &ok)?["commit"], "c");
        let refused = json!({"result":{"isError":true,"content":[{"type":"text","text":"A contribution grant is required"}]}});
        let message = tool_result("attempt_commit", &refused)
            .err()
            .map(|e| e.message);
        assert_eq!(
            message.as_deref(),
            Some("attempt_commit: A contribution grant is required")
        );
        let protocol =
            json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid"}});
        assert!(tool_result("attempt_submit", &protocol).is_err());
        Ok(())
    }
}
