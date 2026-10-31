//! `yoneda change route`: a change's route as text: a line of totals, each commit with the
//! checks and sessions on it, then what those sessions were shown. Sessions read in bytes:
//! tokens per coding session aren't recorded.
use crate::human;
use serde_json::Value;

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

fn plural(count: &Value, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn session_line(session: &Value) -> String {
    let who = match session["model"].as_str() {
        Some(model) => format!("{} {model}", text(session, "cli")),
        None => text(session, "cli").to_owned(),
    };
    let summary = match session["summary"].as_str() {
        Some(summary) => summary.lines().next().unwrap_or_default(),
        None => "(withheld by the repository owner)",
    };
    let read = match session["read_bytes"].as_u64() {
        Some(bytes) => format!(" ({bytes} bytes read)"),
        None => String::new(),
    };
    format!("  session {who}: {summary}{read}")
}

fn delivery_line(delivery: &Value) -> String {
    let cause = match text(delivery, "trigger") {
        "read" => format!("read {}", text(delivery, "subject")),
        "prompt" => "new prompt".to_owned(),
        _ => "session start".to_owned(),
    };
    format!(
        "  {} {cause}: {}, {} bytes",
        text(delivery, "session_id"),
        plural(&list(&delivery["items"]).len().into(), "item", "items"),
        delivery["bytes"]
    )
}

/// The route as lines, in the order they print.
fn lines(route: &Value) -> Vec<String> {
    let totals = &route["totals"];
    let mut out = vec![format!(
        "#{} [{}] {} -> {}: {}, {}, {} bytes read, {} bytes fetched, {} delivered",
        route["number"],
        text(route, "status"),
        text(route, "branch"),
        text(route, "base"),
        plural(&totals["commits"], "commit", "commits"),
        plural(&totals["sessions"], "session", "sessions"),
        totals["read_bytes"],
        totals["fetched_bytes"],
        plural(&totals["memories_delivered"], "memory", "memories"),
    )];
    for commit in list(&route["commits"]) {
        let id = text(commit, "commit");
        out.push(format!(
            "{} {} by {}",
            &id[..id.len().min(12)],
            text(commit, "subject"),
            text(commit, "principal")
        ));
        let on_commit = |item: &&Value| item["commit"] == commit["commit"];
        for check in list(&route["checks"]).iter().filter(on_commit) {
            out.push(format!(
                "  check {} {}",
                text(check, "status"),
                text(check, "name")
            ));
        }
        let sessions = list(&route["sessions"]).iter().filter(on_commit);
        out.extend(sessions.map(session_line));
    }
    let delivered = list(&route["deliveries"]);
    if !delivered.is_empty() {
        out.push("delivered:".to_owned());
        out.extend(delivered.iter().map(delivery_line));
    }
    let cut: Vec<&str> = ["commits", "sessions", "deliveries", "checks"]
        .into_iter()
        .filter(|key| route["truncated"][key] == true)
        .collect();
    if !cut.is_empty() {
        out.push(format!("newest only: {}", cut.join(", ")));
    }
    out
}

pub fn print(route: &Value) {
    for line in lines(route) {
        human!("{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::lines;
    use serde_json::json;

    #[test]
    fn a_withheld_summary_and_a_cut_list_say_so() {
        let route = json!({
            "number": 3, "status": "open", "branch": "fix", "base": "main",
            "totals": { "commits": 1, "sessions": 1, "read_bytes": 0, "fetched_bytes": 0,
                        "memories_delivered": 1 },
            "commits": [{ "commit": "a".repeat(40), "subject": "Fix", "principal": "ada" }],
            "sessions": [{ "commit": "a".repeat(40), "cli": "opencode", "model": null,
                           "summary": null, "read_bytes": null }],
            "checks": [], "deliveries": [],
            "truncated": { "commits": false, "sessions": true, "deliveries": false,
                           "checks": false },
        });
        assert_eq!(
            lines(&route),
            [
                "#3 [open] fix -> main: 1 commit, 1 session, 0 bytes read, 0 bytes fetched, 1 memory delivered",
                "aaaaaaaaaaaa Fix by ada",
                "  session opencode: (withheld by the repository owner)",
                "newest only: sessions",
            ]
        );
    }
}
