//! Wrangler JSONC: parse with comments, render generated configs.
//!
//! Normalisation: generated and committed configs are compared as parsed JSON, so comments,
//! whitespace and key order never count as a difference. A file whose parsed value already
//! matches is left untouched (its hand-written comments survive); a changed file is
//! rewritten with the spec's notes as its header and keys in sorted order.
use crate::process::Result;
use serde_json::Value;
use std::path::Path;

/// Removes `//` and `/* */` comments outside strings.
pub(crate) fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let (mut in_string, mut escaped) = (false, false);
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            match (escaped, c) {
                (true, _) => escaped = false,
                (false, '\\') => escaped = true,
                (false, '"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut previous = ' ';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

pub(crate) fn parse(text: &str) -> Result<Value> {
    Ok(serde_json::from_str(&strip_comments(text))?)
}

pub(crate) fn read(path: &Path) -> Result<Value> {
    parse(&std::fs::read_to_string(path)?)
        .map_err(|error| format!("Cannot parse {}: {error}", path.display()).into())
}

pub(crate) fn render(notes: &[String], config: &Value, spec_path: &str) -> Result<String> {
    let mut out = format!(
        "// Generated from {spec_path} by `cargo xtask infra up`; edit the spec, not this file.\n"
    );
    for line in notes {
        out.push_str(&format!("// {line}\n").replace("// \n", "//\n"));
    }
    out.push_str(&serde_json::to_string_pretty(config)?);
    out.push('\n');
    Ok(out)
}

/// Writes `config` unless the file already parses to the same value. Returns whether the
/// file changed.
pub(crate) fn write_if_changed(
    path: &Path,
    notes: &[String],
    config: &Value,
    spec_path: &str,
) -> Result<bool> {
    if path.exists() && read(path)? == *config {
        return Ok(false);
    }
    std::fs::write(path, render(notes, config, spec_path)?)?;
    Ok(true)
}
