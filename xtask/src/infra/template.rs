//! `{name}` templates in spec strings. An unknown or unclosed template is an error, so a
//! typo never reaches a deployed config.
use crate::process::Result;
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) fn expand(value: &mut Value, vars: &BTreeMap<String, String>) -> Result<()> {
    match value {
        Value::String(text) => *text = substitute(text, vars)?,
        Value::Array(items) => {
            for item in items {
                expand(item, vars)?;
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                expand(item, vars)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn substitute(text: &str, vars: &BTreeMap<String, String>) -> Result<String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let tail = &rest[start + 1..];
        let end = tail
            .find('}')
            .ok_or_else(|| format!("Unclosed template in {text:?}"))?;
        let key = &tail[..end];
        out.push_str(
            vars.get(key)
                .ok_or_else(|| format!("Unknown template {{{key}}} in {text:?}"))?,
        );
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}
