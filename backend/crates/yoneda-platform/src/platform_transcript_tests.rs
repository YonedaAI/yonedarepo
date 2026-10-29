//! Transcripts as the platform stores them: credentials redacted wherever they appear and
//! counted, the size cap applied after redaction, and the document named by its digest.
//! Every token here is assembled at runtime, so this source holds no credential shape.
use crate::platform_compute;
use serde_json::{Value, json};

fn stored(transcript: Value) -> Value {
    platform_compute(json!({ "op": "session_transcript", "transcript": transcript })).unwrap()
}

fn document(out: &Value) -> Value {
    serde_json::from_str(out["document"].as_str().unwrap()).unwrap()
}

#[test]
fn stores_a_transcript_with_its_credentials_redacted() {
    let fake = ["sk-ant-", "api03-"].concat() + &"Ab1".repeat(31);
    let github = ["gh", "p_"].concat() + &"aB3dE5".repeat(6);
    let out = stored(json!({
        "context": format!("YonedaRepo context. Token {github}"),
        "turns": [
            {"kind": "prompt", "text": format!("Use {fake} for the API")},
            {"kind": "tool", "name": "Bash", "subject": "curl", "input": format!("command: curl -H 'x-api-key: {fake}'"),
             "output": "ok"},
            {"kind": "reply", "text": "Done."}
        ]
    }));
    assert!(!out["document"].as_str().unwrap().contains(&fake));
    assert!(!out["document"].as_str().unwrap().contains(&github));
    let doc = document(&out);
    assert_eq!(doc["format"], "yoneda-transcript/1");
    assert_eq!(
        doc["turns"][0]["text"],
        "Use [REDACTED:anthropic-key] for the API"
    );
    assert_eq!(
        doc["context"],
        "YonedaRepo context. Token [REDACTED:github-token]"
    );
    assert_eq!(
        doc["turns"][1]["input"],
        "command: curl -H 'x-api-key: [REDACTED:anthropic-key]'"
    );
    assert_eq!(
        doc["redactions"],
        json!({"anthropic-key": 2, "github-token": 1})
    );
    assert_eq!(doc["truncated"], false);
    let meta = &out["transcript"];
    assert_eq!(meta["redactions"], 3);
    assert_eq!(meta["turns"], 3);
    assert_eq!(meta["context"], true);
    assert_eq!(meta["truncated"], false);
    let text = out["document"].as_str().unwrap();
    assert_eq!(meta["bytes"], text.len());
    assert_eq!(meta["sha256"], yoneda_core::digest(text.as_bytes()));
}

#[test]
fn caps_a_stored_transcript_at_one_mebibyte() {
    let big = "x".repeat(100_000);
    let mut turns = vec![json!({"kind": "prompt", "text": "Start"})];
    for n in 0..300 {
        turns.push(json!({"kind": "tool", "name": "Read", "subject": format!("src/{n}.rs"), "output": big}));
    }
    turns.push(json!({"kind": "reply", "text": "Finished."}));
    let out = stored(json!({ "turns": turns }));
    let meta = &out["transcript"];
    assert_eq!(meta["truncated"], true);
    assert!(meta["bytes"].as_u64().unwrap() <= 1024 * 1024, "{meta}");
    let doc = document(&out);
    let kept = doc["turns"].as_array().unwrap();
    assert_eq!(kept[0]["text"], "Start");
    assert_eq!(kept[1]["kind"], "omitted");
    assert_eq!(kept.last().unwrap()["text"], "Finished.");
    // Each tool output keeps 12 KiB of head and 4 KiB of tail around the cut marker.
    let output = kept[kept.len() - 2]["output"].as_str().unwrap();
    assert!(
        output.contains("[… 83616 bytes cut …]"),
        "{}",
        &output[12_000..12_400]
    );
    assert_eq!(
        kept[1]["turns"].as_u64().unwrap() as usize + kept.len() - 2,
        301
    );
    assert_eq!(meta["turns"].as_u64().unwrap() as usize, kept.len() - 1);
}

#[test]
fn refuses_what_is_not_a_transcript() {
    for bad in [
        json!(null),
        json!({"turns": [{"kind": "thought"}]}),
        json!([1]),
    ] {
        let refused =
            platform_compute(json!({ "op": "session_transcript", "transcript": bad })).unwrap_err();
        assert_eq!(refused.code, "INVALID_INPUT", "{bad}");
    }
}
