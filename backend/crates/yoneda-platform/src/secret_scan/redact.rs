//! Redaction: text the platform keeps rather than commits (session transcripts) has each
//! credential the scanner's rules find replaced, instead of being refused.
use super::{AWS_SECRET, Scanner};

/// `text` with every credential replaced by `[REDACTED:<rule>]`, and the rule of each one
/// replaced, in order. A whole credential goes: a token through its last character, a PEM
/// private key from its header through its footer (or its last body line), and an AWS key
/// id together with every secret access key within 1 KiB of it.
pub fn redact(text: &str) -> (String, Vec<&'static str>) {
    let bytes = text.as_bytes();
    let scanner = Scanner::new(bytes);
    let mut spans: Vec<(usize, usize, &'static str)> = Vec::new();
    let mut rules = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let Some((rule, end)) = scanner.rule_at(i) else {
            i += 1;
            continue;
        };
        rules.push(rule);
        spans.push((i, end, rule));
        if rule == "aws-access-key" {
            for at in scanner.aws_secrets_near(i, end) {
                spans.push((at, at + AWS_SECRET, rule));
            }
        }
        i = end.max(i + 1);
    }
    spans.sort_unstable();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (start, end, rule) in spans {
        if end <= at {
            continue;
        }
        // Every rule starts and ends on an ASCII byte, so these are character boundaries.
        out.push_str(&text[at..start.max(at)]);
        if start >= at {
            out.push_str(&format!("[REDACTED:{rule}]"));
        }
        at = end;
    }
    out.push_str(&text[at..]);
    (out, rules)
}
