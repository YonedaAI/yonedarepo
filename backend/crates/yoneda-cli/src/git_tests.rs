//! Git plumbing with large stdin and stdout: the request is written while the answer is
//! read, so neither pipe can fill and block the other (a clone of a long history once hung
//! forever writing `cat-file --batch-check` ids).
use super::*;
use std::sync::mpsc;
use std::time::Duration;

fn repository() -> (tempfile::TempDir, Git) {
    let dir = tempfile::tempdir().unwrap();
    let git = Git::new(dir.path());
    git.run(&["init", "-q"]).unwrap();
    (dir, git)
}

/// `work` on another thread, failed (not hung) if it outlives `seconds`.
fn within<T: Send + 'static>(seconds: u64, work: impl FnOnce() -> T + Send + 'static) -> T {
    let (sent, received) = mpsc::channel();
    std::thread::spawn(move || sent.send(work()));
    received
        .recv_timeout(Duration::from_secs(seconds))
        .unwrap_or_else(|_| panic!("did not finish within {seconds} s (pipe deadlock)"))
}

#[test]
fn missing_answers_more_ids_than_a_pipe_holds() {
    let (dir, git) = repository();
    // 20,000 ids: about 820 KB in and 980 KB out, far past a 64 KiB pipe either way.
    let ids: Vec<String> = (0..20_000u32).map(|n| format!("{n:040x}")).collect();
    let path = dir.path().to_path_buf();
    let expected = ids.clone();
    let missing = within(30, move || {
        let git = Git::new(path);
        git.missing(&ids)
    })
    .unwrap();
    assert_eq!(missing, expected);
    drop(git);
}

#[test]
fn output_feeds_large_input_while_reading_large_output() {
    let (dir, _git) = repository();
    let path = dir.path().to_path_buf();
    // `hash-object --stdin-paths` reads paths while printing one id each.
    let file = path.join("a.txt");
    std::fs::write(&file, b"x\n").unwrap();
    let line = format!("{}\n", file.display());
    let input = line.repeat(20_000);
    let out = within(30, move || {
        Git::new(path).output(
            &["hash-object", "--stdin-paths"],
            Some(input.as_bytes()),
            &[],
        )
    })
    .unwrap();
    assert_eq!(out.len(), 41 * 20_000);
}

#[test]
fn a_failing_command_reports_its_stderr_even_with_unread_input() {
    let (dir, _git) = repository();
    let path = dir.path().to_path_buf();
    let input = vec![b'x'; 1 << 20];
    let error = within(30, move || {
        Git::new(path)
            .output(&["no-such-git-command"], Some(&input), &[])
            .unwrap_err()
    });
    // git's own complaint, not a broken pipe from the unread input.
    assert!(
        error.message.contains("is not a git command"),
        "{}",
        error.message
    );
}
