//! A coding session's transcript, made ready to store (stateless compute in the Worker): the
//! client's transcript parsed, every credential in it redacted (`secret_scan::redact`), and
//! the result fitted to the stored bounds (`yoneda_core::transcript::STORED`: 1 MiB, 2,000
//! turns, 16 KiB per text). The adapter writes the document to R2 under its SHA-256 and
//! records the metadata this answers with the session record.
use crate::secret_scan::redact;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::transcript::{FORMAT, STORED, Transcript};
use yoneda_core::{Result, digest};

/// `session_transcript {transcript}` → `{document, transcript: {sha256, bytes, turns,
/// redactions, truncated, context}}`: the stored document (JSON text) and what the session
/// record keeps about it.
pub fn session_transcript(c: &Value) -> Result<Value> {
    let mut transcript = Transcript::parse(&c["transcript"])?;
    let mut redacted: BTreeMap<&'static str, u64> = BTreeMap::new();
    for text in transcript.texts_mut() {
        let (clean, rules) = redact(text);
        if rules.is_empty() {
            continue;
        }
        *text = clean;
        for rule in rules {
            *redacted.entry(rule).or_default() += 1;
        }
    }
    // Fitted after redaction: a credential is replaced whole before any cut could split it.
    let truncated = transcript.fit(&STORED);
    let document = json!({
        "format": FORMAT, "context": transcript.context, "turns": transcript.turns,
        "redactions": redacted, "truncated": truncated,
    })
    .to_string();
    Ok(json!({
        "transcript": {
            "sha256": digest(document.as_bytes()), "bytes": document.len(),
            "turns": transcript.steps(), "redactions": redacted.values().sum::<u64>(),
            "truncated": truncated, "context": transcript.context.is_some(),
        },
        "document": document,
    }))
}
