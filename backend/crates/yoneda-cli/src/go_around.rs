//! Go-around: the open findings of a change, as the lines a coding session reads. The
//! session pulls them (`yoneda context`, `yoneda change show`); nothing wakes it. Each line
//! has its file and line, a one-line cut of the finding and, for one left on an older commit,
//! which commit: it may be fixed already.
use crate::agent_hook::truncate;
use crate::context_cmd::DEFAULT_BYTES;
use serde_json::Value;

const FINDING_BYTES: usize = 240;

fn plural(n: u64) -> &'static str {
    if n == 1 { "" } else { "s" }
}

fn open(around: &Value) -> u64 {
    around["open"].as_u64().unwrap_or(0)
}

/// The section's title.
pub fn title(around: &Value) -> String {
    let n = open(around);
    format!(
        "Go-around: {n} open finding{} on change #{} (fix, then push; a re-review runs on the push)",
        plural(n),
        around["change"]
    )
}

/// One line for each finding the platform returned, then a count of the rest.
pub fn entries(around: &Value) -> Vec<String> {
    let findings = around["findings"].as_array().map_or(&[][..], Vec::as_slice);
    let mut out: Vec<String> = findings
        .iter()
        .map(|f| {
            let body = f["body"].as_str().unwrap_or_default();
            let folded = body.split_whitespace().collect::<Vec<_>>().join(" ");
            let mut line = format!(
                "- {}:{}: {}",
                f["path"].as_str().unwrap_or("?"),
                f["line"],
                truncate(&folded, FINDING_BYTES)
            );
            if f["on_head"] == false {
                let commit: String = f["commit"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(7)
                    .collect();
                line.push_str(&format!(" (on older commit {commit})"));
            }
            line
        })
        .collect();
    let rest = open(around).saturating_sub(findings.len() as u64);
    if rest > 0 {
        out.push(format!(
            "- and {rest} more: yoneda change show {}",
            around["change"]
        ));
    }
    out
}

/// The block `yoneda change show` prints, under the size budget of a session's context;
/// `None` when nothing is open.
pub fn block(around: &Value) -> Option<String> {
    let lines = entries(around);
    if lines.is_empty() {
        return None;
    }
    let mut out = title(around);
    out.push('\n');
    for line in lines {
        if out.len() + line.len() + 1 > DEFAULT_BYTES {
            break;
        }
        out.push_str(&line);
        out.push('\n');
    }
    Some(out.trim_end().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nothing_open_prints_nothing() {
        assert_eq!(block(&Value::Null), None);
        assert_eq!(
            block(&json!({"change": 3, "open": 0, "findings": []})),
            None
        );
    }

    #[test]
    fn a_block_has_file_line_and_stays_under_the_budget() {
        let finding = |line: u64| {
            json!({"commit": "a".repeat(40), "path": "src/a.rs", "line": line,
                "body": "x".repeat(4000), "on_head": true})
        };
        let around = json!({"change": 7, "open": 1, "findings": [finding(4)]});
        let text = block(&around).unwrap();
        assert!(text.starts_with("Go-around: 1 open finding on change #7"));
        assert!(text.contains("\n- src/a.rs:4: xxx"));
        assert!(text.len() < 500, "cut: {}", text.len());

        let findings: Vec<Value> = (1..=200).map(finding).collect();
        let many = json!({"change": 7, "open": 200, "findings": findings});
        assert!(block(&many).unwrap().len() <= DEFAULT_BYTES);
    }
}
