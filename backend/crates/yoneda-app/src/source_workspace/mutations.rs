use super::*;
use std::collections::BTreeMap;
pub(super) fn handle<S: SqlStore>(
    db: &S,
    c: &Value,
    state: &mut Value,
    binding: &SourceBinding,
) -> Result<Value> {
    check_version(c, state)?;
    let op = string(c, "op")?;
    let mut final_files = files(db)?;
    let mut updates = BTreeMap::new();
    if op == "source_copy" || op == "source_rename" {
        let from = string(c, "from")?;
        let to = string(c, "to")?;
        if from == to || c["overwrite"] != false {
            return Err(bad(
                "Copy/rename requires distinct paths and overwrite:false",
            ));
        }
        binding.authorize_path(&to)?;
        if op == "source_rename" {
            binding.authorize_path(&from)?;
        }
        let original = check_file(db, &from, &c["expected_from_version"])?;
        let target = check_file(db, &to, &c["expected_to_version"])?;
        if original["file"].is_null() {
            return Err(Error::new("NOT_FOUND", "Source file does not exist"));
        }
        if !target["file"].is_null() {
            return Err(Error::new(
                "ALREADY_EXISTS",
                "Destination file already exists",
            ));
        }
        let mut copied: SourceFile = decode(&original["file"])?;
        copied.path = to.clone();
        final_files.insert(to.clone(), copied.clone());
        updates.insert(to.clone(), updated(target, json!(copied))?);
        if op == "source_rename" {
            final_files.remove(&from);
            updates.insert(from, updated(original, Value::Null)?);
        }
    } else {
        let path = string(c, "path")?;
        binding.authorize_path(&path)?;
        let old = check_file(db, &path, &c["expected_file_version"])?;
        let exists = !old["file"].is_null();
        let file = match op.as_str() {
            "source_delete" => {
                if !exists {
                    return Err(Error::new("NOT_FOUND", "Source file does not exist"));
                }
                None
            }
            "source_chmod" => {
                if !exists {
                    return Err(Error::new("NOT_FOUND", "Source file does not exist"));
                }
                let mut f: SourceFile = decode(&old["file"])?;
                f.mode = decode(&c["mode"])?;
                Some(f)
            }
            "source_create" | "source_write" | "source_truncate" => {
                if op == "source_create" && exists {
                    return Err(Error::new("ALREADY_EXISTS", "Source file already exists"));
                }
                if op == "source_truncate" && !exists {
                    return Err(Error::new("NOT_FOUND", "Truncate source does not exist"));
                }
                let f = tickets::consume(db, c, &path)?;
                if op == "source_truncate" && c["length"].as_u64() != Some(f.size) {
                    return Err(bad("Truncate replacement size differs"));
                }
                Some(f)
            }
            _ => return Err(bad("Unsupported source mutation")),
        };
        if let Some(f) = &file {
            final_files.insert(path.clone(), f.clone());
        } else {
            final_files.remove(&path);
        }
        updates.insert(path, updated(old, json!(file))?);
    }
    validate_files(&final_files)?;
    let version = number(state, "workspace_version")?
        .checked_add(1)
        .ok_or_else(|| bad("Source version overflow"))?;
    let mut versions = serde_json::Map::new();
    for (path, record) in updates {
        versions.insert(path.clone(), record["file_version"].clone());
        save(db, "sw_files", &path, &record)?;
    }
    state["workspace_version"] = json!(version);
    Ok(
        json!({"version":1,"request_id":c["request_id"],"workspace_id":binding.workspace_id,"workspace_version":version,"file_versions":versions,"authority":"staged_source"}),
    )
}
fn updated(mut record: Value, file: Value) -> Result<Value> {
    record["file_version"] = json!(
        number(&record, "file_version")?
            .checked_add(1)
            .ok_or_else(|| bad("File version overflow"))?
    );
    record["file"] = file;
    Ok(record)
}
