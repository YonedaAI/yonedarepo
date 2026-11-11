//! Safe command attribution at the authority boundary. No extra storage or network work.
use serde_json::json;
use worker::Request;

pub(crate) struct CommandObservation {
    request_id: String,
    parent: String,
    first: bool,
    selected: bool,
}

fn identifier(value: Option<String>) -> String {
    value
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
        .unwrap_or_default()
}

impl CommandObservation {
    pub(crate) fn from_request(request: &Request, first: bool) -> Self {
        let headers = request.headers();
        Self {
            request_id: identifier(headers.get("x-request-id").ok().flatten()),
            parent: identifier(headers.get("x-yoneda-parent-span").ok().flatten()),
            first,
            selected: headers.get("x-yoneda-capture").ok().flatten().as_deref() == Some("1"),
        }
    }

    pub(crate) fn completed(&self, operation: &str, error: Option<&yoneda_core::Error>) {
        if (!self.selected && error.is_none()) || self.request_id.is_empty() {
            return;
        }
        let operation = if operation.len() <= 64
            && operation
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        {
            operation
        } else {
            "unknown"
        };
        // The caller measures round-trip time. The runtime supplies invocation CPU separately;
        // a synchronous SQL command cannot obtain a trustworthy CPU timer from the JS clock.
        worker::console_log!(
            "{}",
            json!({
                "event":"repository.command", "level":"info", "operation":operation,
                "request_id":self.request_id, "parent_span_id":self.parent,
                "activation_request":self.first, "outcome":if error.is_some(){"error"}else{"ok"},
                "code":error.map(|e| e.code.as_str()),
            })
        );
    }
}
