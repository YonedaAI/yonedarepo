//! What may enter an organization's audit log: a typed allow-list per event kind. Nothing is
//! passed through: a kind not listed leaves no row, a field not listed or of the wrong type
//! is dropped, and every string kept is scanned for credentials. Webhook URLs keep their
//! host only: a URL's path and query often carry a token.
use super::*;
use crate::secret_scan::redact;

/// Characters a free-text field keeps. Capped after scanning, so that the cap can't cut a
/// credential into something the scanner no longer knows.
const TEXT_LIMIT: usize = 200;
const WORD_LIMIT: usize = 128;

#[derive(Clone, Copy)]
enum Field {
    /// An identifier we generate or validated: an account, team, id or fingerprint.
    Word,
    /// Free text from a caller: a reason, a machine's name.
    Text,
    Count,
    Words,
    /// A URL, logged as `host` and nothing else of it.
    UrlHost,
}
use Field::{Count, Text, UrlHost, Word, Words};

/// Each kind's fields. A kind is added here on purpose, with the fields a reader needs.
const KINDS: &[(&str, &[(&str, Field)])] = &[
    ("org.created", &[("org", Word)]),
    ("org.deleted", &[("org", Word)]),
    (
        "org.member_put",
        &[("account", Word), ("role", Word), ("previous", Word)],
    ),
    ("org.member_removed", &[("account", Word)]),
    ("org.team_created", &[("team", Word), ("id", Count)]),
    ("org.team_deleted", &[("team", Word)]),
    (
        "org.team_member_added",
        &[("team", Word), ("account", Word)],
    ),
    (
        "org.team_member_removed",
        &[("team", Word), ("account", Word)],
    ),
    (
        "pat.created",
        &[
            ("id", Word),
            ("scopes", Words),
            ("repos", Words),
            ("org", Word),
            ("origin", Word),
            ("host", Text),
        ],
    ),
    ("pat.revoked", &[("id", Word), ("org", Word)]),
    (
        "ssh_key.added",
        &[("id", Word), ("fingerprint", Word), ("token", Word)],
    ),
    (
        "ssh_key.removed",
        &[("id", Word), ("reason", Text), ("token", Word)],
    ),
    (
        "account.recovered",
        &[("tokens", Count), ("ssh_keys", Count)],
    ),
    // Repository events start with the next stage; these are their shapes.
    ("webhook.created", &[("id", Word), ("url", UrlHost)]),
    ("webhook.deleted", &[("id", Word), ("url", UrlHost)]),
];

/// The fields of `kind` that may be kept from `data`; `None` when it isn't a logged kind.
pub(super) fn details(kind: &str, data: &Value) -> Option<Value> {
    let (_, fields) = KINDS.iter().find(|(name, _)| *name == kind)?;
    let mut kept = serde_json::Map::new();
    for (name, field) in *fields {
        let value = &data[*name];
        let (key, typed) = match field {
            Word => (*name, word(value)),
            Text => (*name, value.as_str().map(|s| json!(text(s)))),
            Count => (*name, value.as_i64().map(|n| json!(n))),
            Words => (*name, words(value)),
            UrlHost => ("host", value.as_str().and_then(url_host).map(|h| json!(h))),
        };
        if let Some(typed) = typed {
            kept.insert(key.to_owned(), typed);
        }
    }
    Some(Value::Object(kept))
}

/// Who acted: as the event says, or, on a member's own events, that member. An org's event
/// from before actors were recorded names nobody.
pub(super) fn actor(data: &Value, org: &str, source: &str) -> Value {
    if let Some(actor) = word(&data["actor"]) {
        return actor;
    }
    let name = source.strip_prefix("account:").unwrap_or_default();
    match data["by"].as_str() {
        Some(by) => word(&json!(format!("user:{by}"))).unwrap_or(Value::Null),
        None if name != org => word(&json!(format!("user:{name}"))).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

/// Free text as a log keeps it: without credentials, and capped.
pub(super) fn text(value: &str) -> String {
    redact(value).0.chars().take(TEXT_LIMIT).collect()
}

fn word(value: &Value) -> Option<Value> {
    let word = value.as_str()?;
    let allowed = |c: char| c.is_ascii_alphanumeric() || "_-.@:+/=".contains(c);
    (!word.is_empty() && word.len() <= WORD_LIMIT && word.chars().all(allowed))
        .then(|| json!(redact(word).0))
}

fn words(value: &Value) -> Option<Value> {
    let list = value.as_array()?;
    Some(Value::Array(list.iter().filter_map(word).collect()))
}

/// The host of an `http(s)` URL: no scheme, credentials, port, path or query.
fn url_host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    let valid = |c: char| c.is_ascii_alphanumeric() || c == '.' || c == '-';
    (!host.is_empty() && host.chars().all(valid)).then(|| host.to_ascii_lowercase())
}

#[cfg(test)]
pub(super) fn field_names() -> impl Iterator<Item = (&'static str, &'static str)> {
    KINDS
        .iter()
        .flat_map(|(kind, fields)| fields.iter().map(move |(name, _)| (*kind, *name)))
}
