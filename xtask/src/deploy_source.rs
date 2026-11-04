//! A running deployment keeps its captured source even when another branch advances.

use crate::process::Result;
use std::path::Path;

// These feed the Wasm, browser, runtime images, bundle or resolved deployment topology.
// Instructions and root docs do not change those bytes and may advance independently.
const INPUTS: &[&str] = &[
    "backend",
    "cloudflare",
    "frontend",
    "shared",
    "xtask",
    "infra",
    "tools",
    ".cargo",
    ".dockerignore",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "package.json",
    "pnpm-lock.yaml",
    ".npmrc",
];

fn changed(root: &Path, args: &[&str]) -> Result<bool> {
    let output = std::process::Command::new("git")
        .args(args)
        .args(INPUTS)
        .current_dir(root)
        .output()?;
    if !output.status.success() {
        return Err("Cannot verify captured deployment source; stopped before continuing".into());
    }
    Ok(String::from_utf8(output.stdout)?
        .lines()
        .any(|path| !path.ends_with("/AGENTS.md") && path != "AGENTS.md"))
}

fn verify_in(root: &Path, head: &str) -> Result<()> {
    if changed(root, &["diff", "--name-only", "--no-ext-diff", head, "--"])?
        || changed(root, &["ls-files", "--others", "--exclude-standard", "--"])?
    {
        return Err("Runtime/build/configuration source changed during this deployment. Stop and restart from a clean approved tip; the captured deployment was not relabelled as newer HEAD".into());
    }
    Ok(())
}

pub(crate) fn verify(head: &str) -> Result<()> {
    verify_in(Path::new("."), head)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    fn git(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().into()
    }
    #[test]
    fn an_instruction_commit_does_not_relabel_or_stop_a_captured_build_but_runtime_edits_do() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q"]);
        std::fs::create_dir(dir.path().join("cloudflare")).unwrap();
        std::fs::write(dir.path().join("cloudflare/worker.ts"), "original").unwrap();
        git(dir.path(), &["add", "."]);
        git(
            dir.path(),
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "captured",
            ],
        );
        let captured = git(dir.path(), &["rev-parse", "HEAD"]);
        std::fs::write(dir.path().join("AGENTS.md"), "later instructions").unwrap();
        git(dir.path(), &["add", "AGENTS.md"]);
        git(
            dir.path(),
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "instructions",
            ],
        );
        assert_ne!(captured, git(dir.path(), &["rev-parse", "HEAD"]));
        assert!(verify_in(dir.path(), &captured).is_ok());
        std::fs::write(
            dir.path().join("cloudflare/worker.ts"),
            "changed while building",
        )
        .unwrap();
        assert!(verify_in(dir.path(), &captured).is_err());
        git(dir.path(), &["add", "."]);
        git(
            dir.path(),
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "runtime",
            ],
        );
        assert!(verify_in(dir.path(), &captured).is_err());
        std::fs::write(dir.path().join("cloudflare/worker.ts"), "original").unwrap();
        std::fs::write(dir.path().join("cloudflare/new.ts"), "new runtime source").unwrap();
        assert!(verify_in(dir.path(), &captured).is_err());
        std::fs::remove_file(dir.path().join("cloudflare/new.ts")).unwrap();
        assert!(verify_in(dir.path(), &captured).is_ok());
        std::fs::create_dir_all(dir.path().join("tools/fanout-bench")).unwrap();
        std::fs::write(
            dir.path().join("tools/fanout-bench/region-client.js"),
            "new worker",
        )
        .unwrap();
        assert!(verify_in(dir.path(), &captured).is_err());
    }
}
