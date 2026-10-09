use crate::err;
use serde_json::Value;
use yoneda_core::Result;
pub(crate) fn broker_url(path: &str) -> String {
    format!(
        "{}{}",
        std::env::var("YONEDA_BROKER").unwrap_or("http://yoneda.internal".into()),
        path
    )
}
pub(crate) async fn broker(path: &str, body: Value, supervisor: bool) -> Result<Value> {
    let mut request = reqwest::Client::new().post(broker_url(path)).json(&body);
    if supervisor {
        request = request.header(
            "authorization",
            format!("Bearer {}", std::env::var("SUPERVISOR_TOKEN").map_err(err)?),
        );
    }
    let response = request.send().await.map_err(err)?;
    let status = response.status();
    let value: Value = response.json().await.map_err(err)?;
    if !status.is_success() || value.get("error").is_some() {
        return Err(err(value.to_string()));
    }
    Ok(value)
}
