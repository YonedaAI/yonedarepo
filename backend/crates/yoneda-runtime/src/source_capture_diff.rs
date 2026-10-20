//! Real binary Git diff from verified touched-path snapshots only.
use crate::source_git::SourceGitObjects;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read},
    path::PathBuf,
};
pub(crate) const CANDIDATE_DIFF_LIMIT: usize = 24 * 1024 * 1024;
#[derive(Clone, Debug)]
pub(crate) struct SnapshotFile {
    pub file: PathBuf,
    pub executable: bool,
}
pub(crate) fn touched_diff(
    before: &BTreeMap<String, SnapshotFile>,
    after: &BTreeMap<String, SnapshotFile>,
) -> io::Result<String> {
    let directory = tempfile::tempdir()?;
    let mut objects = SourceGitObjects::create(&directory.path().join("review"))?;
    let before_tree = snapshot_tree(&mut objects, before)?;
    let raw = format!(
        "tree {before_tree}\nauthor YonedaRepo review <capture@yoneda.invalid> 0 +0000\ncommitter YonedaRepo review <capture@yoneda.invalid> 0 +0000\n\nTouched-path before\n"
    );
    let before_commit = objects.write("commit", raw.as_bytes())?;
    let after_tree = snapshot_tree(&mut objects, after)?;
    // info/attributes wins over source .gitattributes; no source-selected driver or normalization.
    let mut attributes = String::from("* -filter -text -ident -eol -working-tree-encoding diff\n");
    let mut binary = BTreeSet::new();
    for (path, file) in before.iter().chain(after) {
        if is_binary(file)? {
            binary.insert(path);
        }
    }
    for path in binary {
        let escaped = path
            .chars()
            .flat_map(|c| {
                if matches!(c, '*' | '?' | '[' | ']') {
                    vec!['\\', c]
                } else {
                    vec![c]
                }
            })
            .collect::<String>();
        let quoted = serde_json::to_string(&escaped).map_err(io::Error::other)?;
        attributes.push_str(&format!("{quoted} -diff\n"));
    }
    fs::create_dir_all(objects.root().join("info"))?;
    fs::write(objects.root().join("info/attributes"), attributes)?;
    let patch = objects.execute(
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--no-color",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            &before_commit,
            &after_tree,
        ],
        b"",
        CANDIDATE_DIFF_LIMIT,
    )?;
    String::from_utf8(patch).map_err(|_| io::Error::other("Git produced non-UTF-8 review patch"))
}

fn snapshot_tree(
    objects: &mut SourceGitObjects,
    files: &BTreeMap<String, SnapshotFile>,
) -> io::Result<String> {
    if files.len() > yoneda_agents_core::source_workspace::MAX_FILES {
        return Err(io::Error::other("Touched snapshot exceeds file capability"));
    }
    objects.execute(&["read-tree", "--empty"], b"", 1024)?;
    let mut index = Vec::new();
    let mut total = 0u64;
    for (path, file) in files {
        yoneda_agents_core::validate_path(path).map_err(io::Error::other)?;
        let metadata = fs::symlink_metadata(&file.file)?;
        if !metadata.file_type().is_file()
            || metadata.len() > yoneda_agents_core::source_workspace::MAX_FILE_BYTES
        {
            return Err(io::Error::other(
                "Touched snapshot contains nonregular or oversized file",
            ));
        }
        total = total
            .checked_add(metadata.len())
            .filter(|n| *n <= yoneda_agents_core::source_workspace::MAX_SOURCE_BYTES)
            .ok_or_else(|| io::Error::other("Touched snapshot exceeds byte capability"))?;
        let blob = objects.write_reader("blob", metadata.len(), fs::File::open(&file.file)?)?;
        let mode = if file.executable { "100755" } else { "100644" };
        index.extend(format!("{mode} {blob}\t{path}\0").bytes());
    }
    objects.execute(&["update-index", "-z", "--index-info"], &index, 1024)?;
    let tree = objects.execute(&["write-tree"], b"", 1024)?;
    Ok(std::str::from_utf8(&tree)
        .map_err(io::Error::other)?
        .trim()
        .into())
}

fn is_binary(file: &SnapshotFile) -> io::Result<bool> {
    let mut input = fs::File::open(&file.file)?;
    let mut buffer = [0u8; 65536];
    let mut pending = Vec::new();
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            return Ok(!pending.is_empty());
        }
        if buffer[..count].contains(&0) {
            return Ok(true);
        }
        pending.extend_from_slice(&buffer[..count]);
        match std::str::from_utf8(&pending) {
            Ok(_) => pending.clear(),
            Err(error) if error.error_len().is_some() => return Ok(true),
            Err(error) => {
                pending = pending[error.valid_up_to()..].to_vec();
            }
        }
    }
}
