//! Execute only owner-approved checks with root-derived oracle context.
use crate::{
    err,
    process::{bounded_output, untrusted},
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::process::Command;
use yoneda_core::Result;
pub(crate) async fn run_profile(
    root: &Path,
    profile: &yoneda_core::build::BuildProfile,
) -> Result<Value> {
    run_profile_with_guide(root, profile, None).await
}
pub(super) async fn run_profile_with_guide(
    root: &Path,
    profile: &yoneda_core::build::BuildProfile,
    guide: Option<&Value>,
) -> Result<Value> {
    let mut setup = Vec::new();
    let mut commands = Vec::new();
    let mut setup_ok = true;
    for spec in &profile.setup {
        let output = run_command(root, spec, guide).await?;
        setup_ok &= output["exit"] == 0;
        setup.push(json!({"name":spec.name,"output":output}));
        if !setup_ok {
            break;
        }
    }
    if setup_ok {
        for spec in &profile.checks {
            let output = run_command(root, spec, guide).await?;
            commands.push(json!({"name":spec.name,"output":output}));
        }
    }
    let mut report = json!({"setup":setup,"commands":commands});
    super::guided::record(&mut report, guide);
    Ok(report)
}
async fn run_command(
    root: &Path,
    spec: &yoneda_core::build::CommandSpec,
    guide: Option<&Value>,
) -> Result<Value> {
    let program = spec.argv.first().ok_or_else(|| err("Empty command"))?;
    let mut command = Command::new(program);
    untrusted(&mut command, root);
    command.env("YONEDA_TEST_BUNDLE", "/opt/yoneda/test-bundle");
    if let Some(guide) = guide {
        command.env(
            "GUIDED_CHECK_PHASE",
            guide["check_phase"]
                .as_str()
                .ok_or_else(|| err("Missing guided phase"))?,
        );
        if let Some(variant) = guide["variant"].as_str() {
            command.env("GUIDED_CHECK_VARIANT", variant);
        }
    }
    command.args(&spec.argv[1..]);
    match tokio::time::timeout(
        Duration::from_secs(spec.timeout_seconds),
        bounded_output(&mut command),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Ok(
            json!({"exit":null,"timeout":true,"stdout":"","stderr":"Command exceeded approved timeout"}),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yoneda_core::build::{BuildProfile, CommandSpec};
    #[tokio::test]
    async fn real_oracle_child_receives_each_server_phase_and_variant_after_env_clear() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|path| path.join("node"))
            .find(|path| path.is_file())
            .unwrap();
        let profile=BuildProfile { app:None,setup:vec![],static_dir:None,test_bundle:None,checks:vec![CommandSpec{name:"oracle-context".into(),argv:vec![node.to_string_lossy().into_owned(),"-e".into(),"process.stdout.write(JSON.stringify([process.env.GUIDED_CHECK_PHASE??null,process.env.GUIDED_CHECK_VARIANT??null]))".into()],timeout_seconds:10}] };
        for (step, phase, variant) in [
            ("build", "build", None),
            ("extend", "extend", None),
            ("concurrent", "parallel", Some("filter")),
            ("concurrent", "parallel", Some("sort")),
            ("concurrent", "final", None),
        ] {
            let mut binding = json!({"session_id":"guide-session:test","profile_id":"task-board-v1","version":1,"step_id":step,"check_phase":phase});
            if let Some(variant) = variant {
                binding["variant"] = json!(variant);
            }
            let guide =
                super::super::guided::validate(&json!({"payload":{"guided":binding}})).unwrap();
            let report = run_profile_with_guide(root.path(), &profile, guide.as_ref())
                .await
                .unwrap();
            assert_eq!(report["commands"][0]["output"]["exit"], 0);
            let actual: Value =
                serde_json::from_str(report["commands"][0]["output"]["stdout"].as_str().unwrap())
                    .unwrap();
            assert_eq!(actual, json!([phase, variant]));
            assert_eq!(report["guided_check_phase"], phase);
            assert_eq!(report["guided_check_variant"], json!(variant));
        }
        let legacy = run_profile(root.path(), &profile).await.unwrap();
        assert_eq!(legacy["commands"][0]["output"]["stdout"], "[null,null]");
        assert!(legacy.get("guided_check_phase").is_none());
        assert!(legacy.get("guided_check_variant").is_none());
    }
}
