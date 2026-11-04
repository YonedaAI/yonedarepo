use super::super::provenance::write_receipt;
use super::*;
use serde_json::Value;

const VERSION: &str = "0.1.0";
const REVISION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn cohort() -> Result<tempfile::TempDir> {
    let dir = tempfile::tempdir()?;
    for (target, triple, _) in TARGETS {
        let root = dir.path().join(format!("cli-{target}-{REVISION}"));
        write(
            &root
                .join("cli")
                .join(VERSION)
                .join(archive_name(VERSION, target)),
            target.as_bytes(),
        )?;
        write_receipt(&root, VERSION, target, triple, REVISION)?;
    }
    Ok(dir)
}

#[test]
fn accepts_exactly_the_complete_same_revision_cohort() -> Result<()> {
    let input = cohort()?;
    let archives = validate(input.path(), VERSION, REVISION)?;
    assert_eq!(archives.len(), TARGETS.len());
    for archive in archives {
        assert_eq!(archive.bytes, archive.target.as_bytes());
        assert_eq!(archive.sum, sha256_hex(&archive.bytes));
    }
    Ok(())
}

#[test]
fn refuses_missing_extra_mixed_or_corrupt_inputs_before_any_pointer_write() -> Result<()> {
    for case in [
        "missing",
        "extra",
        "revision",
        "version",
        "target",
        "triple",
        "traversal",
        "size",
        "hash",
        "empty",
        "extra_file",
        "extra_directory",
    ] {
        let input = cohort()?;
        let (target, _, _) = TARGETS[0];
        let root = input.path().join(format!("cli-{target}-{REVISION}"));
        let receipt_path = root.join("receipt.json");
        let mut receipt: Value = serde_json::from_slice(&std::fs::read(&receipt_path)?)?;
        match case {
            "missing" => std::fs::remove_dir_all(&root)?,
            "extra" => std::fs::create_dir(input.path().join("unexpected"))?,
            "revision" => receipt["revision"] = "b".repeat(40).into(),
            "version" => receipt["version"] = "0.0.0".into(),
            "target" => receipt["target"] = TARGETS[1].0.into(),
            "triple" => receipt["triple"] = TARGETS[1].1.into(),
            "traversal" => receipt["archive"] = "../../other.tar.gz".into(),
            "size" => receipt["size"] = 0.into(),
            "hash" => receipt["sha256"] = "0".repeat(64).into(),
            "empty" => std::fs::write(
                root.join("cli")
                    .join(VERSION)
                    .join(archive_name(VERSION, target)),
                [],
            )?,
            "extra_file" => write(&root.join("cli/LATEST"), b"partial")?,
            "extra_directory" => std::fs::create_dir(root.join("extra"))?,
            _ => return Err("Unknown fixture case".into()),
        }
        if root.exists() {
            std::fs::write(receipt_path, serde_json::to_vec(&receipt)?)?;
        }
        let output = tempfile::tempdir()?;
        write(&output.path().join("cli/LATEST"), b"previous")?;
        assert!(
            assemble(
                input.path(),
                output.path(),
                "https://example.test",
                VERSION,
                REVISION
            )
            .is_err(),
            "{case}"
        );
        assert_eq!(
            std::fs::read(output.path().join("cli/LATEST"))?,
            b"previous",
            "{case}"
        );
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn refuses_symlink_archives_and_receipts() -> Result<()> {
    for receipt in [false, true] {
        let input = cohort()?;
        let target = TARGETS[0].0;
        let root = input.path().join(format!("cli-{target}-{REVISION}"));
        let path = if receipt {
            root.join("receipt.json")
        } else {
            root.join("cli")
                .join(VERSION)
                .join(archive_name(VERSION, target))
        };
        let outside = tempfile::NamedTempFile::new()?;
        std::fs::copy(&path, outside.path())?;
        std::fs::remove_file(&path)?;
        std::os::unix::fs::symlink(outside.path(), path)?;
        assert!(validate(input.path(), VERSION, REVISION).is_err());
    }
    Ok(())
}
