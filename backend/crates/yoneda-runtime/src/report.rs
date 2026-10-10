//! Bound serialized evidence without changing verification observations or source diffs.
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(crate) const REPORT_LIMIT: usize = 8 * 1024 * 1024;

pub(crate) fn bounded(mut report: Value) -> Result<Value> {
    while report.to_string().len() > REPORT_LIMIT {
        if !shorten_output(&mut report) {
            return Err(Error::new(
                "REPORT_LIMIT",
                "Report metadata exceeds the 8 MiB evidence cap",
            ));
        }
        report["report_truncated"] = json!(true);
    }
    Ok(report)
}

fn shorten_output(value: &mut Value) -> bool {
    match value {
        Value::Object(fields) => {
            let mut changed = false;
            for key in ["stdout", "stderr"] {
                if let Some(Value::String(text)) = fields.get_mut(key)
                    && !text.is_empty()
                {
                    let mut keep = text.len() / 2;
                    while !text.is_char_boundary(keep) {
                        keep -= 1;
                    }
                    text.truncate(keep);
                    fields.insert(format!("{key}_truncated"), json!(true));
                    changed = true;
                }
            }
            for (key, child) in fields.iter_mut() {
                // `actual` can determine retry eligibility: never shorten assertions.
                if key != "actual" {
                    changed |= shorten_output(child);
                }
            }
            changed
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, item| shorten_output(item) | changed),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_report_retains_every_command_exit_and_setup_failure() {
        let text = "🦀\0".repeat(200_000);
        let report = json!({"environment":"pinned","suite":"commands-v1",
            "setup":[{"name":"install","output":{"exit":7,"stdout":text,"stderr":text}}],
            "commands":[{"name":"build","output":{"exit":0,"stdout":text,"stderr":text}},
                        {"name":"test","output":{"exit":null,"timeout":true,"stdout":text,"stderr":text}}]});
        assert!(report.to_string().len() > REPORT_LIMIT);
        let report = bounded(report).unwrap();
        assert!(report.to_string().len() <= REPORT_LIMIT);
        assert_eq!(report["setup"][0]["output"]["exit"], 7);
        assert_eq!(report["commands"][0]["output"]["exit"], 0);
        assert_eq!(report["commands"][1]["output"]["timeout"], true);
        assert_eq!(report["environment"], "pinned");
        assert_eq!(report["report_truncated"], true);
    }

    #[test]
    fn oversized_assertions_are_rejected_instead_of_changing_verification() {
        let report = json!({"cases":[{"actual":{"stdout":"x".repeat(REPORT_LIMIT + 1)}}]});
        assert_eq!(bounded(report).unwrap_err().code, "REPORT_LIMIT");
    }
}
