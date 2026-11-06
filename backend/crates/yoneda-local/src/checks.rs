//! Local checks on the exact revision about to land on a protected branch: the pushed
//! commit for a fast-forward, the platform's merge commit otherwise (the combined result,
//! which exists in no worktree). Runs go through the engine's fenced check runs
//! (`repo_check_request`, `_claim`, `_complete`), so each verdict is recorded against its
//! commit, tree, file-set digest and policy digest; a commit already passed under the same
//! policy is not run again. A check that fails, times out or cannot run refuses the
//! landing: it fails closed.
//!
//! Checks run while the branch's landing lock is held, so the revision checked is the one
//! that lands; landings on that branch wait for them.
use crate::authority::Cred;
use crate::check_cmd;
use crate::layout::local_error;
use crate::service::Service;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use yoneda_core::Result;

const CHECKS: Cred = Cred::System("checks");
/// The output a refusal and the recorded evidence keep: its last bytes.
const TAIL_BYTES: usize = 2048;
/// Output lines shown to the pusher from a failing check.
const TAIL_LINES: usize = 12;

/// Whether the policy has any checks (one authority read, no run requested).
pub fn configured(svc: &Service, cred: &Cred) -> bool {
    svc.authority
        .call(cred, json!({ "op": "repo_status" }))
        .is_ok_and(|s| {
            s["policy"]["runners"]
                .as_object()
                .is_some_and(|r| !r.is_empty())
        })
}

/// Runs every check on `commit`; answers why the landing is refused, if it is.
pub fn gate(
    svc: &Service,
    cred: &Cred,
    commit: &str,
    merged: bool,
    messages: &mut Vec<String>,
) -> Option<String> {
    let on = if merged { " on the merged result" } else { "" };
    let runs = match svc.authority.call(
        cred,
        json!({ "op": "repo_check_request", "commit": commit }),
    ) {
        Ok(answer) => answer["runs"].as_array().cloned().unwrap_or_default(),
        Err(e) => return Some(format!("checks could not start: {}", e.message)),
    };
    for run in runs {
        let name = run["name"].as_str().unwrap_or_default().to_owned();
        if run["status"] == "passed" {
            continue;
        }
        let verdict = if run["status"] == "failed" {
            Ok(Verdict::Fail("it failed before on this commit".into()))
        } else {
            execute(svc, run["id"].as_str().unwrap_or_default())
        };
        let why = match verdict {
            Ok(Verdict::Pass) => continue,
            Ok(Verdict::Fail(tail)) => {
                for line in tail
                    .lines()
                    .rev()
                    .take(TAIL_LINES)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                {
                    messages.push(format!("check {name}: {line}"));
                }
                format!("check {name} failed{on}")
            }
            Ok(Verdict::TimedOut(seconds)) => {
                format!("check {name} timed out after {seconds}s{on}")
            }
            Err(e) => format!("check {name} could not run{on}: {}", e.message),
        };
        messages.push("next: git pull, fix, commit, git push".into());
        return Some(why.chars().take(300).collect());
    }
    None
}

enum Verdict {
    Pass,
    Fail(String),
    TimedOut(u64),
}

/// Claims run `id`, runs it in a fresh checkout and records the verdict.
fn execute(svc: &Service, id: &str) -> Result<Verdict> {
    let claim = svc
        .authority
        .call(&CHECKS, json!({ "op": "repo_check_claim", "run_id": id }))?;
    if claim["done"] == true {
        return Ok(match claim["status"].as_str() {
            Some("passed") => Verdict::Pass,
            _ => Verdict::Fail("it failed before on this commit".into()),
        });
    }
    if claim["busy"] == true {
        return Err(local_error("another run of it is in progress"));
    }
    let epoch = claim["epoch"].as_u64().unwrap_or(0);
    let commit = claim["commit"].as_str().unwrap_or_default().to_owned();
    let tree = claim["tree"].as_str().unwrap_or_default().to_owned();
    let paths: Vec<String> = serde_json::from_value(claim["paths"].clone()).unwrap_or_default();
    let timeout = claim["timeout_seconds"].as_u64().unwrap_or(600);
    let run = format!("{id}-{epoch}");
    let dir = svc
        .layout
        .store()
        .parent()
        .map_or_else(|| PathBuf::from("checks"), |p| p.join("checks"))
        .join(&run);
    let ran = checkout(svc, &commit, &tree, &paths, &dir).and_then(|digest| {
        let command: Vec<String> = claim["command"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str())
            .map(|a| {
                a.replace("{checkout}", &dir.to_string_lossy())
                    .replace("{run}", &run)
            })
            .collect();
        let image = check_cmd::image_of(claim["command"].as_array().map_or(&[][..], Vec::as_slice));
        let started = Instant::now();
        let (code, tail) = spawn(&command, &dir, timeout, image.is_some().then_some(&run))?;
        Ok((
            digest,
            code,
            tail,
            started.elapsed().as_millis() as u64,
            image,
        ))
    });
    let _ = std::fs::remove_dir_all(&dir);
    let (digest, code, tail, ms, image) = match ran {
        Ok(done) => done,
        Err(e) => {
            let _ = svc.authority.call(
                &CHECKS,
                json!({ "op": "repo_check_complete", "run_id": id, "epoch": epoch,
                        "outcome": "error", "evidence": { "error": e.message } }),
            );
            return Err(e);
        }
    };
    let outcome = if code == Some(0) { "pass" } else { "fail" };
    svc.authority.call(
        &CHECKS,
        json!({ "op": "repo_check_complete", "run_id": id, "epoch": epoch, "outcome": outcome,
                "evidence": { "commit": commit, "tree": tree, "files_sha256": digest,
                              "exit_code": code, "ms": ms, "output_tail": tail,
                              "ran": image.map_or_else(|| "host".to_owned(), |i| format!("image {i}")) } }),
    )?;
    Ok(match code {
        Some(0) => Verdict::Pass,
        Some(_) => Verdict::Fail(tail),
        None => Verdict::TimedOut(timeout),
    })
}

/// Writes `commit`'s files (within `paths`, none: all) into `dir`; answers the digest of
/// the file set, one `type id path` line per file in path order, as the cloud's executor.
fn checkout(
    svc: &Service,
    commit: &str,
    tree: &str,
    paths: &[String],
    dir: &Path,
) -> Result<String> {
    std::fs::create_dir_all(dir).map_err(|e| local_error(format!("No check directory: {e}")))?;
    let mut archive = vec!["archive", "--format=tar", commit, "--"];
    archive.extend(paths.iter().map(String::as_str));
    let tar = svc.store.git(&archive, None)?;
    let mut untar = Command::new("tar")
        .args(["-x", "-f", "-", "-C"])
        .arg(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| local_error(format!("Cannot run tar: {e}")))?;
    if let Some(mut pipe) = untar.stdin.take() {
        use std::io::Write;
        pipe.write_all(&tar)
            .map_err(|e| local_error(format!("Cannot unpack: {e}")))?;
    }
    let done = untar
        .wait_with_output()
        .map_err(|e| local_error(format!("Cannot unpack: {e}")))?;
    if !done.status.success() {
        return Err(local_error(format!(
            "Cannot unpack: {}",
            String::from_utf8_lossy(&done.stderr).trim()
        )));
    }
    let mut ls = vec!["ls-tree", "-r", "-z", tree, "--"];
    ls.extend(paths.iter().map(String::as_str));
    let listed = svc.store.git(&ls, None)?;
    let mut lines: Vec<(String, String)> = listed
        .split(|b| *b == 0)
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let l = String::from_utf8_lossy(l);
            let (meta, path) = l.split_once('\t')?;
            let mut f = meta.split(' ').skip(1);
            Some((
                path.to_owned(),
                format!("{} {} {path}\n", f.next()?, f.next()?),
            ))
        })
        .collect();
    lines.sort();
    let text: String = lines.into_iter().map(|(_, line)| line).collect();
    Ok(yoneda_core::digest(text.as_bytes()))
}

/// Runs `command` in `dir` in its own process group; `None` exit code: it timed out and
/// was stopped (the group by its recorded id, a container by its run name).
fn spawn(
    command: &[String],
    dir: &Path,
    timeout: u64,
    container: Option<&String>,
) -> Result<(Option<i32>, String)> {
    use std::os::unix::process::CommandExt;
    let (program, args) = command
        .split_first()
        .ok_or_else(|| local_error("The check has no command"))?;
    let log = dir.with_extension("log");
    let out = std::fs::File::create(&log).map_err(|e| local_error(format!("No check log: {e}")))?;
    let err = out
        .try_clone()
        .map_err(|e| local_error(format!("No check log: {e}")))?;
    let mut child = Command::new(program)
        .args(args)
        .current_dir(dir)
        .env_remove("YONEDA_TOKEN")
        .env_remove("YONEDA_LOCAL_TIMINGS")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .process_group(0)
        .spawn()
        .map_err(|e| local_error(format!("Cannot start {program}: {e}")))?;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.code().unwrap_or(-1)),
            Ok(None) if Instant::now() >= deadline => {
                if let Some(name) = container {
                    let _ = Command::new("docker")
                        .args(["kill", &format!("yoneda-check-{name}")])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
                let _ = Command::new("kill")
                    .args(["-KILL", &format!("-{}", child.id())])
                    .stderr(Stdio::null())
                    .status();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(local_error(format!("The check was lost: {e}"))),
        }
    };
    let bytes = std::fs::read(&log).unwrap_or_default();
    let _ = std::fs::remove_file(&log);
    let tail =
        String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(TAIL_BYTES)..]).into_owned();
    Ok((code, tail))
}
