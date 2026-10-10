//! Shared validation for adapter-verified Git conflict capture results.
pub use yoneda_core::conflict_capture::validate_capture_result;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn job() -> Value {
        json!({"id":"capture:refresh:req-1","kind":"capture","status":"running","epoch":4,"payload":{"capture_subtype":"refresh_candidate","expected_base":"a".repeat(40),"expected_head":"b".repeat(40),"expected_version":7,"declared_paths":["src/change.rs"],"candidate":{"revision":{"commit":"c".repeat(40)}}}})
    }

    fn result() -> Value {
        json!({"status":"clean","candidate_id":format!("candidate:refresh:{}", "e".repeat(40)),"tree":"d".repeat(40),"merge_commit":"e".repeat(40),"revision":{"commit":"e".repeat(40)},"paths":["src/change.rs"],"readback":{"observed_head":"b".repeat(40),"version":7,"parents":["b".repeat(40),"c".repeat(40)],"candidate_paths":["src/change.rs"],"intervening_paths":["README.md"],"merge_commit":"e".repeat(40),"merged_paths":["src/change.rs"]},"evidence":{"base_commit":"a".repeat(40),"observed_head":"b".repeat(40),"candidate_commit":"c".repeat(40),"declared_paths":["src/change.rs"],"captured_paths":["src/change.rs"],"intervening_paths":["README.md"],"overlapping_paths":[]}})
    }

    #[test]
    fn adapter_binds_git_evidence_to_the_active_leased_capture() {
        assert!(validate_capture_result(&job(), "capture:refresh:req-1", 4, &result()).is_ok());
        assert_eq!(
            validate_capture_result(&job(), "capture:refresh:req-1", 3, &result())
                .unwrap_err()
                .code,
            "FENCED"
        );
        let mut forged = result();
        forged["evidence"]["captured_paths"] = json!(["outside.rs"]);
        assert!(validate_capture_result(&job(), "capture:refresh:req-1", 4, &forged).is_err());
    }
}
