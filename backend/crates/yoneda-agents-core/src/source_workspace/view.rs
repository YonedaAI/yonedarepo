use super::*;
use std::collections::BTreeMap;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceRevision {
    pub repository: String,
    pub commit: String,
    pub tree: String,
}
impl SourceRevision {
    pub fn validate(&self) -> Result<()> {
        validate_id(&self.repository)?;
        validate_hash(&self.commit, &[40, 64])?;
        validate_hash(&self.tree, &[40, 64])
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum FileMode {
    #[serde(rename = "100644")]
    Regular,
    #[serde(rename = "100755")]
    Executable,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ContentRef {
    Git {
        repository: String,
        commit: String,
        path: String,
        blob: String,
    },
    R2 {
        key: String,
        sha256: String,
        size: u64,
        ticket_id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceFile {
    pub path: String,
    pub mode: FileMode,
    pub size: u64,
    pub content: ContentRef,
}
impl SourceFile {
    pub fn validate(&self) -> Result<()> {
        crate::validate_path(&self.path)?;
        if self.size > MAX_FILE_BYTES {
            return Err(invalid("Source file exceeds limit"));
        }
        match &self.content {
            ContentRef::Git {
                repository,
                commit,
                path,
                blob,
            } => {
                validate_id(repository)?;
                crate::validate_path(path)?;
                validate_hash(commit, &[40, 64])?;
                validate_hash(blob, &[40, 64])?;
            }
            ContentRef::R2 {
                key,
                sha256,
                size,
                ticket_id,
            } => {
                validate_id(ticket_id)?;
                validate_hash(sha256, &[64])?;
                if *size != self.size || key.len() > 1024 || !key.starts_with("source/v1/") {
                    return Err(invalid("Invalid source content reference"));
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceView {
    pub version: u32,
    pub base: SourceRevision,
    pub files: Vec<SourceFile>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BaselineOverride {
    pub path: String,
    pub file: Option<SourceFile>,
}
pub fn merged_baseline(
    view: &SourceView,
    overrides: &[BaselineOverride],
) -> Result<BTreeMap<String, SourceFile>> {
    if view.version != 1 || view.files.len() > MAX_FILES || overrides.len() > MAX_FILES {
        return Err(invalid("Invalid source view version or count"));
    }
    view.base.validate()?;
    let mut files = BTreeMap::new();
    let mut previous = "";
    for file in &view.files {
        file.validate()?;
        if file.path.as_str() <= previous {
            return Err(invalid("Source index paths must be sorted unique"));
        }
        previous = &file.path;
        files.insert(file.path.clone(), file.clone());
    }
    previous = "";
    for item in overrides {
        crate::validate_path(&item.path)?;
        if item.path.as_str() <= previous {
            return Err(invalid("Baseline overrides must be sorted unique"));
        }
        previous = &item.path;
        if let Some(file) = &item.file {
            file.validate()?;
            if file.path != item.path {
                return Err(invalid("Override path differs from metadata"));
            }
            files.insert(item.path.clone(), file.clone());
        } else {
            files.remove(&item.path);
        }
    }
    validate_files(&files)?;
    Ok(files)
}
pub fn validate_files(files: &BTreeMap<String, SourceFile>) -> Result<()> {
    if files.len() > MAX_FILES {
        return Err(invalid("Source file count exceeded"));
    }
    let mut total = 0u64;
    for (path, file) in files {
        file.validate()?;
        total = total
            .checked_add(file.size)
            .filter(|n| *n <= MAX_SOURCE_BYTES)
            .ok_or_else(|| invalid("Source byte limit exceeded"))?;
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if files.contains_key(prefix) {
                return Err(invalid("A source file is also a directory"));
            }
            parent = prefix;
        }
    }
    Ok(())
}

/// Frozen scratch namespaces are granted only when no merged source entry can be shadowed.
pub fn scratch_paths_for(files: &BTreeMap<String, SourceFile>, role: SourceRole) -> Vec<String> {
    if matches!(
        role,
        SourceRole::Reviewer | SourceRole::Planner | SourceRole::Coordinator
    ) {
        return vec![];
    }
    SCRATCH_PREFIXES
        .iter()
        .filter(|prefix| {
            !files
                .keys()
                .any(|path| path == prefix.trim_end_matches('/') || path.starts_with(**prefix))
        })
        .map(|p| (*p).to_owned())
        .collect()
}
