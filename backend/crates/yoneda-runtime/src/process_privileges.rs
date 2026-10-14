//! Explicit privilege removal; deployed container UID behavior is not an authority boundary alone.
#[cfg(target_os = "linux")]
pub(crate) fn restrict_untrusted() -> std::io::Result<()> {
    #[repr(C)]
    struct Header {
        version: u32,
        pid: i32,
    }
    #[repr(C)]
    struct Capabilities {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }
    let header = Header {
        version: 0x2008_0522,
        pid: 0,
    };
    let data = [
        Capabilities {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
        Capabilities {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
    ];
    // SAFETY: these are async-signal-safe kernel calls in the forked child. Header
    // and two capability words implement Linux capability ABI version 3.
    unsafe {
        if libc::prctl(
            libc::PR_CAP_AMBIENT,
            libc::PR_CAP_AMBIENT_CLEAR_ALL,
            0,
            0,
            0,
        ) != 0
            || libc::syscall(libc::SYS_capset, &header, data.as_ptr()) != 0
            || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::{os::unix::process::CommandExt, process::Command};

    #[test]
    fn child_exec_has_no_current_capabilities_and_cannot_gain_privilege() {
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let mut child = Command::new("/usr/bin/python3");
        child.args(["-c", "import pathlib; v=dict(x.split(':',1) for x in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in x); assert all(int(v[k].strip(),16)==0 for k in ['CapEff','CapPrm','CapInh','CapAmb']); assert v['NoNewPrivs'].strip()=='1'"]);
        unsafe {
            child.pre_exec(super::restrict_untrusted);
        }
        let output = child.output().unwrap();
        assert!(
            output.status.success(),
            "Child privilege state was not restricted"
        );
    }
}
