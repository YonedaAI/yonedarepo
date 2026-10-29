//! A JSON Schema check for the subset the committed CLI schemas use (`type`, `properties`,
//! `required`, `additionalProperties`, `items`, local `$ref`, `const`, `enum`, `anyOf`,
//! `oneOf`, `minimum`). A keyword outside that subset fails the check, so a schema that
//! grows past it cannot pass by being ignored.
use serde_json::Value;

const KNOWN: &[&str] = &[
    "$schema",
    "$defs",
    "$ref",
    "title",
    "description",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "const",
    "enum",
    "anyOf",
    "oneOf",
    "format",
    "minimum",
    "default",
];

/// Every place `value` breaks `schema` (resolved against `root`), as `path: reason`.
pub fn errors(root: &Value, schema: &Value, value: &Value, at: &str) -> Vec<String> {
    let mut out = Vec::new();
    check(root, schema, value, at, &mut out);
    out
}

fn check(root: &Value, schema: &Value, value: &Value, at: &str, out: &mut Vec<String>) {
    let Some(map) = schema.as_object() else {
        if schema != &Value::Bool(true) {
            out.push(format!("{at}: unsupported schema {schema}"));
        }
        return;
    };
    for key in map.keys() {
        if !KNOWN.contains(&key.as_str()) {
            out.push(format!("{at}: unsupported keyword {key}"));
        }
    }
    if let Some(target) = map.get("$ref").and_then(Value::as_str) {
        let name = target.strip_prefix("#/$defs/").unwrap_or(target);
        match root["$defs"].get(name) {
            Some(def) => check(root, def, value, at, out),
            None => out.push(format!("{at}: unresolved $ref {target}")),
        }
    }
    if let Some(expected) = map.get("const")
        && expected != value
    {
        out.push(format!("{at}: expected {expected}, got {value}"));
    }
    if let Some(options) = map.get("enum").and_then(Value::as_array)
        && !options.contains(value)
    {
        out.push(format!("{at}: {value} is not one of {options:?}"));
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(options) = map.get(key).and_then(Value::as_array) {
            let passing = options
                .iter()
                .filter(|o| errors(root, o, value, at).is_empty())
                .count();
            let fits = if key == "anyOf" {
                passing > 0
            } else {
                passing == 1
            };
            if !fits {
                out.push(format!("{at}: {value} matches {passing} of {key}"));
            }
        }
    }
    if let Some(kind) = map.get("type") {
        let kinds: Vec<&str> = match kind {
            Value::String(k) => vec![k.as_str()],
            Value::Array(ks) => ks.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !kinds.iter().any(|k| is(k, value)) {
            out.push(format!("{at}: {value} is not {kinds:?}"));
        }
    }
    if let (Some(min), Some(n)) = (map.get("minimum").and_then(Value::as_f64), value.as_f64())
        && n < min
    {
        out.push(format!("{at}: {n} is below {min}"));
    }
    if let Some(object) = value.as_object() {
        let properties = map.get("properties").and_then(Value::as_object);
        for name in map
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !object.contains_key(name) {
                out.push(format!("{at}: missing {name}"));
            }
        }
        for (name, field) in object {
            let path = format!("{at}.{name}");
            match (
                properties.and_then(|p| p.get(name)),
                map.get("additionalProperties"),
            ) {
                (Some(sub), _) => check(root, sub, field, &path, out),
                (None, Some(Value::Bool(false))) => out.push(format!("{path}: not in the schema")),
                (None, Some(extra)) => check(root, extra, field, &path, out),
                (None, None) => {}
            }
        }
    }
    if let (Some(items), Some(array)) = (map.get("items"), value.as_array()) {
        for (i, item) in array.iter().enumerate() {
            check(root, items, item, &format!("{at}[{i}]"), out);
        }
    }
}

fn is(kind: &str, value: &Value) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        _ => false,
    }
}
