use crate::err;
use serde_json::Value;
use yoneda_agents_core::Result;
pub(crate) fn broker_url(path: &str) -> String {
    format!(
        "{}{}",
        std::env::var("YONEDA_BROKER").unwrap_or("http://yoneda.internal".into()),
        path
    )
}
pub(crate) async fn broker(path: &str, body: Value, supervisor: bool) -> Result<Value> {
    let mut request = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(err)?
        .post(broker_url(path))
        .json(&body);
    if supervisor {
        request = request.header(
            "authorization",
            format!("Bearer {}", std::env::var("SUPERVISOR_TOKEN").map_err(err)?),
        );
    }
    let response = request.send().await.map_err(err)?;
    let status = response.status();
    let value: Value = response.json().await.map_err(err)?;
    if rejected(status.is_success(), &value) {
        return Err(err(value.to_string()));
    }
    Ok(value)
}

/// Worker rejections are `{"error":{"code","message"}}`. A successful `/failed` callback returns
/// the failed job, whose `error` field is a string; that is an acknowledgment, not a rejection.
fn rejected(success: bool, value: &Value) -> bool {
    !success || value["error"].is_object()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn a_failed_job_acknowledgment_is_not_a_callback_rejection() {
        let acknowledged = json!({"attempt":1,"epoch":4,"status":"failed",
            "error":"EXECUTION_TIMEOUT: Execution deadline exceeded"});
        assert!(!super::rejected(true, &acknowledged));
        assert!(super::rejected(
            true,
            &json!({"error":{"code":"FENCED","message":"stale"}})
        ));
        assert!(super::rejected(false, &json!({})));
    }
}
