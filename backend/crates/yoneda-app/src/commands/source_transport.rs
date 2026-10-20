//! Freeze API source identity only after the authenticated Worker reads Artifacts.
use serde_json::Value;
use yoneda_core::{Error, Result, source_workspace::SourceRevision};

pub(super) fn freeze(command: &Value, run: &mut Value) -> Result<()> {
    if run["workspace_transport"] != "api-source-v1" {
        return Ok(());
    }
    if command["_source_transport_approved"] != true {
        return Err(Error::new(
            "FORBIDDEN",
            "Source transport requires adapter approval",
        ));
    }
    let source: SourceRevision = serde_json::from_value(command["_source_base"].clone())
        .map_err(|_| Error::new("INVALID_INPUT", "Approved source metadata is missing"))?;
    source.validate()?;
    if source.repository != run["base"]["repository"].as_str().unwrap_or_default()
        || source.commit != run["base"]["commit"].as_str().unwrap_or_default()
    {
        return Err(Error::new(
            "HEAD_MOVED",
            "Approved source changed before run creation",
        ));
    }
    run["source_base"] = command["_source_base"].clone();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn run() -> Value {
        json!({"workspace_transport":"api-source-v1","base":{"repository":"test/canonical","commit":"a".repeat(40)}})
    }
    fn approved() -> Value {
        json!({"_source_transport_approved":true,"_source_base":{"repository":"test/canonical","commit":"a".repeat(40),"tree":"b".repeat(40)}})
    }
    #[test]
    fn adapter_approval_is_required_and_frozen_to_exact_working_source() {
        let mut pending = run();
        let mut forged = approved();
        forged["_source_transport_approved"] = json!(false);
        assert_eq!(freeze(&forged, &mut pending).unwrap_err().code, "FORBIDDEN");
        assert!(pending.get("source_base").is_none());
        let mut moved = approved();
        moved["_source_base"]["commit"] = json!("c".repeat(40));
        assert_eq!(freeze(&moved, &mut pending).unwrap_err().code, "HEAD_MOVED");
        freeze(&approved(), &mut pending).unwrap();
        assert_eq!(pending["source_base"], approved()["_source_base"]);
    }
    #[test]
    fn legacy_run_transport_and_approval_remain_unchanged() {
        let mut legacy = json!({"base":{"commit":"old"}});
        let before = legacy.clone();
        freeze(&approved(), &mut legacy).unwrap();
        assert_eq!(legacy, before);
    }
}
