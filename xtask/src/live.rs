use crate::process::Result;
use serde_json::Value;
pub(crate) async fn api_authenticated(
    url: &str,
    path: &str,
    body: Option<Value>,
    secret: &str,
) -> Result<Value> {
    let mut request = reqwest::Client::new()
        .request(
            if body.is_some() {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            format!("{}/api/{path}", url.trim_end_matches('/')),
        )
        .bearer_auth(secret);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await?;
    let status = response.status();
    let value: Value = response.json().await?;
    if !status.is_success() {
        return Err(value.to_string().into());
    }
    Ok(value)
}
