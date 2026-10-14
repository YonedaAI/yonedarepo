//! Observe the actual deployed child privilege state before advertising a security capability.
use serde_json::{Value, json};
pub(crate) fn probe() -> Value {
    #[cfg(target_os = "linux")]
    {
        use std::{
            os::unix::process::CommandExt,
            process::{Command, Stdio},
        };
        let mut child = Command::new("/bin/cat");
        child
            .arg("/proc/self/status")
            .env_clear()
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .uid(1000)
            .gid(1000);
        // SAFETY: root-owned fixed executable; helper contains only async-signal-safe syscalls.
        unsafe {
            child.pre_exec(crate::process_privileges::restrict_untrusted);
        }
        if let Ok(output) = child.output()
            && output.status.success()
            && output.stdout.len() <= 64 * 1024
            && let Ok(status) = std::str::from_utf8(&output.stdout)
        {
            return observed(status);
        }
    }
    json!({"verified":false})
}
#[cfg(any(test, target_os = "linux"))]
fn observed(status: &str) -> Value {
    let field = |name: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name}:")).map(str::trim))
    };
    let ids = |name: &str| {
        field(name).is_some_and(|values| {
            values.split_whitespace().count() == 4
                && values.split_whitespace().all(|id| id == "1000")
        })
    };
    let zero =
        |name: &str| field(name).and_then(|value| u64::from_str_radix(value, 16).ok()) == Some(0);
    if !ids("Uid")
        || !ids("Gid")
        || !["CapEff", "CapPrm", "CapInh", "CapAmb"]
            .iter()
            .all(|field| zero(field))
        || field("NoNewPrivs") != Some("1")
    {
        return json!({"verified":false});
    }
    // Whitelisted observed values only. Never return the full process status/environment.
    json!({"verified":true,"uid":1000,"gid":1000,"effective":"0","permitted":"0","inheritable":"0","ambient":"0","no_new_privs":1})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn actual_root_probe_observes_zero_capability_masks_after_uid1000_exec() {
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let proof = probe();
        assert_eq!(proof["verified"], true);
        assert_eq!(proof["uid"], 1000);
        assert_eq!(proof["no_new_privs"], 1);
    }
    #[test]
    fn incomplete_root_or_nonzero_child_state_never_claims_verified() {
        let safe = "Uid:\t1000 1000 1000 1000\nGid:\t1000 1000 1000 1000\nCapEff:\t0\nCapPrm:\t0\nCapInh:\t0\nCapAmb:\t0\nNoNewPrivs:\t1\n";
        assert_eq!(observed(safe)["verified"], true);
        for unsafe_state in [
            safe.replace("CapEff:\t0", "CapEff:\t200000"),
            safe.replace("Uid:\t1000", "Uid:\t0"),
            safe.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
            safe.replace("CapAmb:\t0\n", ""),
        ] {
            assert_eq!(observed(&unsafe_state)["verified"], false);
        }
    }
}
