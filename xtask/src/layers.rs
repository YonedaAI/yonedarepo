//! `cargo xtask layers`: every dependency edge between workspace crates must be in the
//! allow-table `xtask/layers.toml`, read against `cargo metadata`.
use crate::process::Result;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::process::Command;

const TABLE: &str = "xtask/layers.toml";
/// The main workspace, then the SSH gateway's own workspace.
const WORKSPACES: [Option<&str>; 2] = [None, Some("backend/crates/yoneda-ssh-gateway/Cargo.toml")];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Layers {
    allow: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Deserialize)]
struct Metadata {
    packages: Vec<Package>,
}

#[derive(Deserialize)]
struct Package {
    name: String,
    dependencies: Vec<Dependency>,
}

#[derive(Deserialize)]
struct Dependency {
    name: String,
    /// `null` for normal dependencies, else `"dev"` or `"build"`.
    kind: Option<String>,
}

pub(crate) fn check() -> Result<()> {
    let layers: Layers = toml::from_str(&std::fs::read_to_string(TABLE)?)
        .map_err(|error| format!("{TABLE}: {error}"))?;
    let mut packages = Vec::new();
    for manifest in WORKSPACES {
        packages.extend(metadata(manifest)?.packages);
    }
    let errors = violations(&layers, &packages);
    if !errors.is_empty() {
        return Err(format!("{TABLE} violations:\n  {}", errors.join("\n  ")).into());
    }
    println!("layers: {} crates match {TABLE}", packages.len());
    Ok(())
}

fn metadata(manifest: Option<&str>) -> Result<Metadata> {
    let mut command = Command::new("cargo");
    command.args(["metadata", "--format-version", "1", "--no-deps"]);
    if let Some(path) = manifest {
        command.args(["--manifest-path", path]);
    }
    let output = command.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("cargo metadata {manifest:?} failed: {stderr}").into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

/// Unlisted crates, unknown table rows and normal/build edges the table does not allow.
fn violations(layers: &Layers, packages: &[Package]) -> Vec<String> {
    let crates: BTreeSet<&str> = packages.iter().map(|p| p.name.as_str()).collect();
    let mut errors = Vec::new();
    for name in &crates {
        if !layers.allow.contains_key(*name) {
            errors.push(format!("crate {name} has no [allow] row"));
        }
    }
    for (name, allowed) in &layers.allow {
        for listed in std::iter::once(name).chain(allowed) {
            if !crates.contains(listed.as_str()) {
                errors.push(format!("[allow] {name} names unknown crate {listed}"));
            }
        }
    }
    for package in packages {
        for dependency in &package.dependencies {
            let kind = dependency.kind.as_deref().unwrap_or("normal");
            let internal = crates.contains(dependency.name.as_str());
            if kind == "dev" || !internal || dependency.name == package.name {
                continue;
            }
            let allowed = layers.allow.get(&package.name);
            if !allowed.is_some_and(|set| set.contains(&dependency.name)) {
                errors.push(format!(
                    "{} -> {} ({kind}) is not allowed",
                    package.name, dependency.name
                ));
            }
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(name: &str, dependencies: &[(&str, Option<&str>)]) -> Package {
        Package {
            name: name.into(),
            dependencies: dependencies
                .iter()
                .map(|(name, kind)| Dependency {
                    name: (*name).into(),
                    kind: kind.map(Into::into),
                })
                .collect(),
        }
    }

    fn table(source: &str) -> Layers {
        toml::from_str(source).expect("valid table")
    }

    #[test]
    fn the_committed_table_parses_and_lists_core_as_a_leaf() {
        let layers = table(include_str!("../layers.toml"));
        assert_eq!(layers.allow.get("yoneda-core"), Some(&BTreeSet::new()));
    }

    #[test]
    fn rejects_an_edge_missing_from_the_table() {
        let layers = table("[allow]\ncore = []\nplatform = [\"core\"]\nworker = [\"core\"]\n");
        let packages = [
            package("core", &[]),
            package("platform", &[("core", None)]),
            package("worker", &[("core", None), ("platform", Some("build"))]),
        ];
        assert_eq!(
            violations(&layers, &packages),
            ["worker -> platform (build) is not allowed"]
        );
    }

    #[test]
    fn ignores_dev_and_external_dependencies() {
        let layers = table("[allow]\ncore = []\nstore = []\n");
        let packages = [
            package("core", &[("serde", None), ("store", Some("dev"))]),
            package("store", &[]),
        ];
        assert!(violations(&layers, &packages).is_empty());
    }

    #[test]
    fn requires_a_row_per_crate_and_known_names() {
        let layers = table("[allow]\ncore = [\"gone\"]\n");
        let packages = [package("core", &[]), package("cli", &[("core", None)])];
        assert_eq!(
            violations(&layers, &packages),
            [
                "crate cli has no [allow] row",
                "[allow] core names unknown crate gone",
                "cli -> core (normal) is not allowed",
            ]
        );
    }
}
