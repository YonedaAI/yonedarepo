//! The committed JSON Schemas of the `--json` documents: `schemas/v1/<command>.schema.json`
//! at the workspace root, generated from the `Report` types (`cargo xtask contracts`
//! writes them; `committed_schemas_match_the_types` fails while one is stale or extra).
use super::*;
use serde_json::{Map, Value, json};

/// The directory of the schemas, relative to the workspace root.
pub const DIR: &str = "schemas/v1";

/// The schema of `R`'s whole document: `schema` is the constant id, `data` is `R`.
pub fn of<R: Report>() -> Value {
    let root = schemars::generate::SchemaSettings::draft2020_12()
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<R>()
        .to_value();
    let mut data = root.as_object().cloned().unwrap_or_default();
    let mut defs = match data.remove("$defs") {
        Some(Value::Object(defs)) => defs,
        _ => Map::new(),
    };
    data.remove("$schema");
    let name = data
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Data")
        .to_owned();
    defs.insert(name.clone(), Value::Object(data));
    let id = schema_id(R::COMMAND);
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": id,
        "description": format!("The `yoneda --json` document of `{}`.", R::COMMAND),
        "type": "object",
        "additionalProperties": false,
        "required": ["schema", "data"],
        "properties": {
            "schema": { "const": id, "type": "string" },
            "data": { "$ref": format!("#/$defs/{name}") },
        },
        "$defs": defs,
    })
}

/// Every document's (command, schema).
pub fn all() -> Vec<(&'static str, Value)> {
    fn entry<R: Report>() -> (&'static str, Value) {
        (R::COMMAND, of::<R>())
    }
    vec![
        entry::<ErrorReport>(),
        entry::<RepoCreate>(),
        entry::<RepoList>(),
        entry::<RepoVisibility>(),
        entry::<RepoDelete>(),
        entry::<RepoImport>(),
        entry::<RepoFork>(),
        entry::<OrgList>(),
        entry::<OrgCreate>(),
        entry::<OrgShow>(),
        entry::<OrgRepos>(),
        entry::<OrgDelete>(),
        entry::<OrgMemberAdd>(),
        entry::<OrgMemberRemove>(),
        entry::<OrgTeamCreate>(),
        entry::<OrgTeamDelete>(),
        entry::<OrgTeamAdd>(),
        entry::<OrgTeamRemove>(),
        entry::<SshKeyAdd>(),
        entry::<SshKeyList>(),
        entry::<SshKeyRemove>(),
        entry::<Login>(),
        entry::<Logout>(),
        entry::<Setup>(),
        entry::<TokenCreate>(),
        entry::<TokenList>(),
        entry::<TokenRevoke>(),
        entry::<CheckRun>(),
        entry::<CheckStatus>(),
        entry::<Land>(),
        entry::<ChangeLand>(),
        entry::<Rebase>(),
        entry::<Review>(),
        entry::<PolicyShow>(),
        entry::<PolicySet>(),
        entry::<ChangeCreate>(),
        entry::<ChangeList>(),
        entry::<ChangeShow>(),
        entry::<ChangeComment>(),
        entry::<ReleaseCreate>(),
        entry::<ReleaseList>(),
        entry::<ReleaseShow>(),
        entry::<SessionRecord>(),
        entry::<SessionList>(),
        entry::<MemoryAdd>(),
        entry::<MemoryList>(),
        entry::<MemoryShow>(),
        entry::<MemoryRetire>(),
        entry::<Log>(),
        entry::<Grep>(),
        entry::<Search>(),
        entry::<Blame>(),
        entry::<Diff>(),
        entry::<Symbols>(),
        entry::<ReadsAdd>(),
        entry::<ReadsList>(),
        entry::<ReadsClear>(),
        entry::<Conflicts>(),
        entry::<Context>(),
        entry::<Cloned>(),
        entry::<SparseScope>(),
        entry::<Status>(),
        entry::<Pull>(),
        entry::<Synced>(),
    ]
}

/// Every schema file: (file name, contents).
pub fn files() -> Vec<(String, String)> {
    all()
        .into_iter()
        .map(|(command, schema)| {
            let text = serde_json::to_string_pretty(&schema).unwrap_or_default();
            (format!("{command}.schema.json"), format!("{text}\n"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::Path;

    #[test]
    fn committed_schemas_match_the_types() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(DIR);
        let expected: BTreeMap<String, String> = files().into_iter().collect();
        let committed: BTreeMap<String, String> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_str()?.to_owned();
                let text = std::fs::read_to_string(entry.path()).ok()?;
                Some((name, text))
            })
            .collect();
        let stale: std::collections::BTreeSet<&String> = expected
            .keys()
            .chain(committed.keys())
            .filter(|name| expected.get(*name) != committed.get(*name))
            .collect();
        assert!(
            stale.is_empty(),
            "{DIR} differs from the Rust types for {stale:?}: run `cargo xtask contracts`"
        );
    }

    #[test]
    fn every_command_has_one_schema() {
        let names: Vec<&str> = all().iter().map(|(name, _)| *name).collect();
        let mut unique = names.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), names.len(), "{names:?}");
    }
}
