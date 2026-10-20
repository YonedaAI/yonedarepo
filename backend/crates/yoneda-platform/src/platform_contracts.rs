//! Contract records tied to symbols (paper §7.3): inputs, outputs, effects, errors and
//! invariants. A contract is either derived from a symbol's signature and doc comments at
//! a revision, or authored through the API and recorded by the authority against the
//! symbol's node digest. An authored record whose digest no longer matches the symbol is
//! reported stale and never served as the symbol's contract.
use crate::storage::bad;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use yoneda_core::Result;

const MAX_ITEMS: usize = 64;
const MAX_TEXT: usize = 2000;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub inputs: Vec<Param>,
    #[serde(default)]
    pub outputs: Vec<Output>,
    #[serde(default)]
    pub effects: Vec<String>,
    #[serde(default)]
    pub errors: Vec<Failure>,
    #[serde(default)]
    pub invariants: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Param {
    pub name: String,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Output {
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// A returned error value (`Result::Err`).
    Error,
    /// A Rust panic.
    Panic,
    /// A thrown JavaScript exception or rejected promise.
    Throw,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub kind: FailureKind,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn text_ok(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_TEXT
}

impl Contract {
    /// Parses and bounds an authored contract from untrusted JSON.
    pub fn parse(value: &Value) -> Result<Self> {
        let contract: Self = serde_json::from_value(value.clone()).map_err(|e| {
            bad(&format!(
                "contract must have summary, inputs, outputs, effects, errors and invariants only: {e}"
            ))
        })?;
        let counts = [
            contract.inputs.len(),
            contract.outputs.len(),
            contract.effects.len(),
            contract.errors.len(),
            contract.invariants.len(),
        ];
        if counts.iter().any(|n| *n > MAX_ITEMS) {
            return Err(bad("A contract list holds at most 64 entries"));
        }
        let optional = |t: &Option<String>| t.as_deref().is_none_or(text_ok);
        let valid = optional(&contract.summary)
            && contract
                .inputs
                .iter()
                .all(|p| text_ok(&p.name) && optional(&p.ty) && optional(&p.description))
            && contract
                .outputs
                .iter()
                .all(|o| optional(&o.ty) && optional(&o.description))
            && contract.effects.iter().all(|t| text_ok(t))
            && contract
                .errors
                .iter()
                .all(|f| optional(&f.ty) && optional(&f.description))
            && contract.invariants.iter().all(|t| text_ok(t));
        if !valid {
            return Err(bad(
                "Contract text must be non-blank and at most 2000 characters",
            ));
        }
        if contract == Self::default() {
            return Err(bad("An authored contract must state something"));
        }
        Ok(contract)
    }
}

/// The contract that governs one symbol at a revision. `symbol` carries the current node
/// `digest` and the `contract` derived at that revision; `records` are the authority's
/// authored records for this symbol, oldest first.
pub fn resolve(symbol: &Value, records: &[Value]) -> Value {
    let digest = &symbol["digest"];
    let derived = &symbol["contract"];
    let matching = records.iter().rev().find(|r| r["node_digest"] == *digest);
    let meta = |r: &Value| {
        json!({ "seq": r["seq"], "commit": r["commit"], "node_digest": r["node_digest"],
            "recorded_by": r["recorded_by"], "recorded_at": r["recorded_at"] })
    };
    match (matching, records.last()) {
        (Some(record), _) => json!({ "status": "authored", "node_digest": digest,
            "contract": record["contract"], "authored": meta(record), "derived": derived }),
        (None, Some(latest)) => json!({ "status": "stale", "node_digest": digest,
            "contract": Value::Null, "derived": derived,
            "stale": { "record": meta(latest), "contract": latest["contract"],
                "reason": "The symbol changed after this contract was recorded" } }),
        (None, None) => json!({ "status": "derived", "node_digest": digest,
            "contract": derived, "derived": derived }),
    }
}

/// Sections of a doc comment: the summary paragraph and `# Heading` sections (rustdoc) or
/// `@tag` entries (JSDoc), each as the list of entries it contains.
#[derive(Debug, Default)]
pub struct Doc {
    pub summary: Option<String>,
    pub sections: Vec<(String, Vec<String>)>,
}

impl Doc {
    pub fn section(&self, names: &[&str]) -> Vec<String> {
        self.sections
            .iter()
            .filter(|(name, _)| names.iter().any(|n| name.eq_ignore_ascii_case(n)))
            .flat_map(|(_, entries)| entries.clone())
            .collect()
    }
}

fn join(lines: &[&str]) -> Option<String> {
    let text = lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty()).then(|| text.chars().take(MAX_TEXT).collect())
}

/// Splits section text into entries: one per list item, otherwise one per paragraph.
fn entries(lines: &[&str]) -> Vec<String> {
    let mut out: Vec<Vec<&str>> = Vec::new();
    let mut fresh = true;
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            fresh = true;
        } else if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            out.push(vec![item]);
            fresh = false;
        } else if fresh || out.is_empty() {
            out.push(vec![trimmed]);
            fresh = false;
        } else if let Some(last) = out.last_mut() {
            last.push(trimmed);
        }
    }
    out.iter().filter_map(|e| join(e)).collect()
}

/// Rustdoc text (the joined `///` lines) into its summary and `# Heading` sections.
pub fn rustdoc(text: &str) -> Doc {
    let mut doc = Doc::default();
    let mut current: Option<String> = None;
    let mut buffer: Vec<&str> = Vec::new();
    let mut in_code = false;
    let flush = |name: &Option<String>, buffer: &mut Vec<&str>, doc: &mut Doc| {
        match name {
            None => {
                let first: Vec<&str> = buffer
                    .iter()
                    .copied()
                    .take_while(|l| !l.trim().is_empty())
                    .collect();
                doc.summary = join(&first);
            }
            Some(name) => doc.sections.push((name.clone(), entries(buffer))),
        }
        buffer.clear();
    };
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        if let Some(heading) = line.trim().strip_prefix("# ") {
            flush(&current, &mut buffer, &mut doc);
            current = Some(heading.trim().to_owned());
        } else {
            buffer.push(line);
        }
    }
    flush(&current, &mut buffer, &mut doc);
    doc
}

/// A `/** ... */` comment into its summary and `@tag` entries (tag text without the tag).
pub fn jsdoc(comment: &str) -> Doc {
    let body = comment
        .trim()
        .trim_start_matches("/**")
        .trim_end_matches("*/");
    let lines: Vec<&str> = body
        .lines()
        .map(|l| {
            let l = l.trim();
            l.strip_prefix('*').map_or(l, str::trim_start)
        })
        .collect();
    let mut doc = Doc::default();
    let mut summary: Vec<&str> = Vec::new();
    let mut tag: Option<(String, Vec<&str>)> = None;
    for line in lines {
        if let Some(rest) = line.strip_prefix('@') {
            if let Some((name, parts)) = tag.take() {
                doc.sections
                    .push((name, join(&parts).into_iter().collect()));
            }
            let (name, text) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            tag = Some((name.to_owned(), vec![text]));
        } else if let Some((_, parts)) = tag.as_mut() {
            parts.push(line);
        } else {
            summary.push(line);
        }
    }
    if let Some((name, parts)) = tag {
        doc.sections
            .push((name, join(&parts).into_iter().collect()));
    }
    let first: Vec<&str> = summary
        .iter()
        .copied()
        .skip_while(|l| l.trim().is_empty())
        .take_while(|l| !l.trim().is_empty())
        .collect();
    doc.summary = join(&first);
    doc
}

/// `{Type} rest` → (`Some(Type)`, `rest`), for JSDoc type expressions.
pub fn braced_type(text: &str) -> (Option<String>, &str) {
    let Some(inner) = text.strip_prefix('{') else {
        return (None, text);
    };
    match inner.find('}') {
        Some(end) => (
            Some(inner[..end].trim().to_owned()),
            inner[end + 1..].trim(),
        ),
        None => (None, text),
    }
}

/// `name - description`, `` `name`: description `` or `name description`.
pub fn named(text: &str) -> (String, Option<String>) {
    let text = text.trim();
    let (name, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    let name = name.trim_matches(|c| c == '`' || c == ':' || c == '[' || c == ']');
    let rest = rest.trim().trim_start_matches(['-', ':', '–']).trim();
    (
        name.split('=').next().unwrap_or(name).to_owned(),
        (!rest.is_empty()).then(|| rest.to_owned()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authored_contracts_are_bounded_and_closed() {
        let ok = json!({"summary": "Retries", "errors": [{"kind": "error", "type": "Timeout"}]});
        assert_eq!(
            Contract::parse(&ok).unwrap().errors[0].kind,
            FailureKind::Error
        );
        for bad in [
            json!({}),
            json!({"summary": "x", "extra": 1}),
            json!({"errors": [{"kind": "oops"}]}),
            json!({"effects": [" "]}),
            json!({"invariants": ["x".repeat(2001)]}),
            json!({"effects": vec!["x"; 65]}),
        ] {
            assert!(Contract::parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn stale_records_are_reported_never_served() {
        let symbol = json!({"digest": "d2", "contract": {"summary": "derived"}});
        let old = json!({"seq": 1, "node_digest": "d1", "contract": {"summary": "authored"}});
        let stale = resolve(&symbol, std::slice::from_ref(&old));
        assert_eq!(stale["status"], "stale");
        assert!(stale["contract"].is_null());
        assert_eq!(stale["stale"]["contract"]["summary"], "authored");
        let fresh = json!({"seq": 2, "node_digest": "d2", "contract": {"summary": "new"}});
        let current = resolve(&symbol, &[old, fresh]);
        assert_eq!(
            (
                current["status"].as_str(),
                current["contract"]["summary"].as_str()
            ),
            (Some("authored"), Some("new"))
        );
        assert_eq!(resolve(&symbol, &[])["status"], "derived");
    }

    #[test]
    fn doc_comments_split_into_summary_and_sections() {
        let doc = rustdoc(
            "Retries with backoff.\nUp to three times.\n\n# Errors\n\n- `Timeout` when slow\n- `Refused`\n\n# Panics\nIf attempts is zero.\n```\n# not a heading\n```",
        );
        assert_eq!(
            doc.summary.as_deref(),
            Some("Retries with backoff. Up to three times.")
        );
        assert_eq!(
            doc.section(&["errors"]),
            ["`Timeout` when slow", "`Refused`"]
        );
        assert_eq!(doc.section(&["Panics"]), ["If attempts is zero."]);
        let js = jsdoc(
            "/**\n * Loads a user.\n * @param {string} id - the user id\n * @returns {User} the user\n * @throws {NotFound} when missing\n */",
        );
        assert_eq!(js.summary.as_deref(), Some("Loads a user."));
        assert_eq!(js.section(&["param"]), ["{string} id - the user id"]);
        let throws = js.section(&["throws"]);
        let (ty, rest) = braced_type(&throws[0]);
        assert_eq!((ty.as_deref(), rest), (Some("NotFound"), "when missing"));
        assert_eq!(named("`id`: the id"), ("id".into(), Some("the id".into())));
    }
}
