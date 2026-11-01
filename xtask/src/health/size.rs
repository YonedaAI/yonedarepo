//! Worker Wasm and frontend bundle sizes against `xtask/size-budget.toml`: today's measured
//! bytes plus a margin, so a jump fails and a deliberate rise is a reviewed one-line change.
use crate::process::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

const TABLE: &str = "xtask/size-budget.toml";
const WASM: &str = "backend/crates/yoneda-worker/build/index_bg.wasm";
const DIST: &str = "frontend/dist";

/// Bytes: the Worker's Wasm; the frontend's JavaScript and CSS; everything it serves.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Sizes {
    pub wasm: u64,
    pub js: u64,
    pub css: u64,
    pub dist: u64,
}

fn budget(root: &Path) -> Result<Sizes> {
    let text = std::fs::read_to_string(root.join(TABLE))?;
    Ok(toml::from_str(&text).map_err(|error| format!("{TABLE}: {error}"))?)
}

fn add_files(dir: &Path, sizes: &mut Sizes) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            add_files(&entry.path(), sizes)?;
            continue;
        }
        let bytes = entry.metadata()?.len();
        sizes.dist += bytes;
        match entry.path().extension().and_then(|text| text.to_str()) {
            Some("js") => sizes.js += bytes,
            Some("css") => sizes.css += bytes,
            _ => {}
        }
    }
    Ok(())
}

pub(super) fn measure(root: &Path) -> Result<Sizes> {
    let wasm = std::fs::metadata(root.join(WASM))
        .map_err(|error| format!("No {WASM} ({error}): run `cargo xtask build`"))?;
    let mut sizes = Sizes {
        wasm: wasm.len(),
        js: 0,
        css: 0,
        dist: 0,
    };
    add_files(&root.join(DIST), &mut sizes)
        .map_err(|error| format!("No {DIST} ({error}): run `cargo xtask build`"))?;
    Ok(sizes)
}

fn breaches(budget: &Sizes, sizes: &Sizes) -> Vec<String> {
    [
        ("Worker Wasm", sizes.wasm, budget.wasm),
        ("frontend JavaScript", sizes.js, budget.js),
        ("frontend CSS", sizes.css, budget.css),
        ("frontend total", sizes.dist, budget.dist),
    ]
    .into_iter()
    .filter(|(_, size, limit)| size > limit)
    .map(|(name, size, limit)| {
        format!("{name}: {size} bytes, over its budget of {limit} in {TABLE}")
    })
    .collect()
}

pub(super) fn current_breaches(root: &Path, sizes: &Sizes) -> Result<Vec<String>> {
    Ok(breaches(&budget(root)?, sizes))
}

fn check_at(root: &Path) -> Result<Sizes> {
    let sizes = measure(root)?;
    let errors = current_breaches(root, &sizes)?;
    if !errors.is_empty() {
        return Err(format!("Size budget:\n  {}", errors.join("\n  ")).into());
    }
    Ok(sizes)
}

/// The gate; needs the Wasm and frontend builds.
pub(crate) fn check() -> Result<()> {
    let sizes = check_at(&std::env::current_dir()?)?;
    println!(
        "size: wasm {} js {} css {} total {} bytes, inside {TABLE}",
        sizes.wasm, sizes.js, sizes.css, sizes.dist
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree with a Wasm of `wasm` bytes and a frontend of 10 KB of JS and 1 KB of CSS.
    fn tree(wasm: usize) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let write = |path: &str, bytes: usize| {
            let path = dir.path().join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, vec![0; bytes]).unwrap();
        };
        write(WASM, wasm);
        write("frontend/dist/assets/index-abc.js", 10_000);
        write("frontend/dist/assets/index-abc.css", 1_000);
        write("frontend/dist/index.html", 500);
        std::fs::create_dir_all(dir.path().join("xtask")).unwrap();
        let budget = "wasm = 5000\njs = 10000\ncss = 1000\ndist = 11500\n";
        std::fs::write(dir.path().join(TABLE), budget).unwrap();
        dir
    }

    #[test]
    fn measures_each_kind_of_file() {
        let dir = tree(4_000);
        let sizes = check_at(dir.path()).unwrap();
        let expected = Sizes {
            wasm: 4_000,
            js: 10_000,
            css: 1_000,
            dist: 11_500,
        };
        assert_eq!(sizes, expected);
    }

    #[test]
    fn a_wasm_jump_fails() {
        let dir = tree(5_001);
        let error = check_at(dir.path()).unwrap_err().to_string();
        assert!(
            error.contains("Worker Wasm: 5001 bytes, over its budget of 5000"),
            "{error}"
        );
    }

    #[test]
    fn a_missing_build_fails_rather_than_measuring_nothing() {
        let dir = tree(1);
        std::fs::remove_file(dir.path().join(WASM)).unwrap();
        assert!(check_at(dir.path()).is_err());
    }

    #[test]
    fn the_committed_budget_parses() {
        let budget: Sizes = toml::from_str(include_str!("../../size-budget.toml")).unwrap();
        assert!(budget.wasm > 0 && budget.js > 0 && budget.css > 0);
        assert!(budget.dist >= budget.js + budget.css);
    }
}
