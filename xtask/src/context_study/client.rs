use crate::process::Result;
use serde_json::{Value, json};
use std::path::Path;
pub(super) struct Client {
    pub url: String,
    http: reqwest::Client,
    cookie: String,
}
impl Client {
    pub async fn login(url: &str, credentials: &Path) -> Result<Self> {
        let input: Value = serde_json::from_slice(&std::fs::read(credentials)?)?;
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(100))
            .build()?;
        let response = http
            .post(format!("{url}/api/auth/login"))
            .json(&json!({"username":input["username"],"password":input["password"]}))
            .send()
            .await?;
        if !response.status().is_success() {
            return Err("Study account login failed; credentials were not logged".into());
        }
        let cookie = response
            .headers()
            .get("set-cookie")
            .ok_or("Login returned no cookie")?
            .to_str()?
            .split(';')
            .next()
            .ok_or("Invalid cookie")?
            .to_owned();
        Ok(Self {
            url: url.trim_end_matches('/').to_owned(),
            http,
            cookie,
        })
    }
    pub async fn api(&self, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self
            .http
            .request(
                if body.is_some() {
                    reqwest::Method::POST
                } else {
                    reqwest::Method::GET
                },
                format!("{}/api/{path}", self.url),
            )
            .header("cookie", &self.cookie);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?;
        let status = response.status();
        let value: Value = response.json().await?;
        if !status.is_success() {
            return Err(format!(
                "Study API failed ({status}): {}",
                value["error"]["code"].as_str().unwrap_or("REQUEST_FAILED")
            )
            .into());
        }
        Ok(value)
    }
    pub async fn mcp(
        &self,
        repo: &str,
        grant: &str,
        session: Option<&str>,
        name: &str,
        args: Value,
    ) -> Result<Value> {
        let mut request = self
            .http
            .post(format!("{}/mcp/{repo}", self.url))
            .bearer_auth(grant);
        if let Some(session) = session {
            request = request.header("Mcp-Session-Id", session);
        }
        let value:Value=request.json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}})).send().await?.json().await?;
        if value["result"]["isError"] == true || !value["error"].is_null() {
            return Err(format!("Scoped study tool failed: {name}").into());
        }
        Ok(serde_json::from_str(
            value["result"]["content"][0]["text"]
                .as_str()
                .ok_or("Missing MCP result")?,
        )?)
    }
    pub async fn session(&self, repo: &str, grant: &str) -> Result<String> {
        let response=self.http.post(format!("{}/mcp/{repo}",self.url)).bearer_auth(grant).json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"yoneda-context-study","version":"1"},"capabilities":{}}})).send().await?;
        if !response.status().is_success() {
            return Err("Study MCP initialize failed".into());
        }
        Ok(response
            .headers()
            .get("Mcp-Session-Id")
            .ok_or("Missing server session")?
            .to_str()?
            .to_owned())
    }
}
pub(super) fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Missing study field: {key}").into())
}
