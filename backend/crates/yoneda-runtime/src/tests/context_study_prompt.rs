//! Synthetic corpus canaries exercise actual hosted prompt construction without inference.
use serde_json::json;

#[test]
fn study_prompts_preload_only_explicit_plain_notes_and_never_inline_graph_history() {
    let canary = "FROZEN-CORPUS-SECRET-CANARY";
    let legacy_canary = "LEGACY-INLINE-CONTEXT-CANARY";
    let record = json!({"id":"context:trial-canary","kind":"constraint","label":canary,
        "author":"fixture","recorded_at":1000,"data":{"statement":canary,"purpose":"Synthetic trial note","links":[]}});
    for arm in ["source_only", "plain_notes", "graph"] {
        let payload = json!({"execution":{"role":"coding","strategy":"minimal","context":[]},
            "run":{"id":"trial","intent":"Improve the website","criteria":["Accessible navigation"],
                "context_records":[{"label":legacy_canary}],
                "context_study":{"id":"prompt-trial","case":"website_update","arm":arm,
                    "corpus":["context:trial-canary"],"records":[record]}},
            "policy":{"build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}});
        let prompt = crate::prompt::prompt(&payload).unwrap();
        assert!(prompt.contains("Improve the website"));
        assert!(prompt.contains("Accessible navigation"));
        assert!(!prompt.contains(legacy_canary));
        if arm == "plain_notes" {
            let exact_notes = json!({"plain_notes":[record]}).to_string();
            assert!(prompt.contains(&exact_notes));
            assert!(prompt.contains(canary));
        } else {
            assert!(!prompt.contains(canary));
            assert!(!prompt.contains("context:trial-canary"));
            assert!(!prompt.contains("plain_notes"));
        }
    }
}
