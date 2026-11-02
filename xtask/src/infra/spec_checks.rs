//! Derive check-container and queue capacity from the shared spec setting.
use crate::process::Result;
use serde_json::{Value, json};

const CHECK_CLASS: &str = "CheckContainer";
const CHECK_QUEUE_BINDING: &str = "PLATFORM_CHECKS";

/// Writes `check_instances` into the CheckContainer and its queue consumer.
pub(super) fn derive_checks(
    config: &mut serde_json::Map<String, Value>,
    instances: Option<u64>,
) -> Result<()> {
    let has_checks = config
        .get("containers")
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|c| c["class_name"] == CHECK_CLASS));
    if !has_checks {
        return Ok(());
    }
    let n = instances.ok_or("A Worker runs CheckContainer, so the spec needs check_instances")?;
    for container in config
        .get_mut("containers")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if container["class_name"] == CHECK_CLASS {
            container["max_instances"] = json!(n);
        }
    }
    let queue = config["queues"]["producers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["binding"] == CHECK_QUEUE_BINDING)
        .and_then(|p| p["queue"].as_str())
        .map(str::to_owned)
        .ok_or("CheckContainer without a PLATFORM_CHECKS queue producer")?;
    for consumer in config
        .get_mut("queues")
        .and_then(|q| q.get_mut("consumers"))
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if consumer["queue"] == queue.as_str() {
            consumer["max_concurrency"] = json!(n);
        }
    }
    Ok(())
}
