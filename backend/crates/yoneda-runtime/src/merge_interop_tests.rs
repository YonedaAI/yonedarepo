//! Differential test: the platform's three-way merge agrees with `git merge-file
//! --diff-algorithm=histogram` on whether a merge is clean and on the clean result.
use std::path::Path;
use std::process::Command;
use yoneda_core::merge::{TextMerge, merge3};

struct Lcg(u64);
impl Lcg {
    fn next(&mut self, n: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) % n
    }
}

fn edit(base: &[String], rng: &mut Lcg, tag: &str) -> Vec<String> {
    let mut lines = base.to_vec();
    for _ in 0..=rng.next(3) {
        let at = rng.next(lines.len() as u64 + 1) as usize;
        match rng.next(3) {
            0 if at < lines.len() => lines[at] = format!("{tag} changed {at}"),
            1 if at < lines.len() => {
                lines.remove(at);
            }
            _ => lines.insert(at, format!("{tag} inserted {at}")),
        }
    }
    lines
}

fn git_merge(dir: &Path, base: &str, ours: &str, theirs: &str) -> (bool, String) {
    for (name, text) in [("base", base), ("ours", ours), ("theirs", theirs)] {
        std::fs::write(dir.join(name), text).unwrap();
    }
    let output = Command::new("/usr/bin/git")
        .args([
            "merge-file",
            "-p",
            "--diff-algorithm=histogram",
            "ours",
            "base",
            "theirs",
        ])
        .current_dir(dir)
        .output()
        .unwrap();
    // merge-file exits with the conflict count (at most 127); higher codes are usage or I/O
    // errors, which must not be read as "conflicted".
    let code = output.status.code().unwrap();
    assert!(
        (0..128).contains(&code),
        "git merge-file failed ({code}): {}",
        String::from_utf8_lossy(&output.stderr)
    );
    (code == 0, String::from_utf8(output.stdout).unwrap())
}

/// `merge-file --diff-algorithm` needs Git 2.44+; the container image ships Debian's older Git,
/// so the differential check runs where a recent Git exists (developer machines and CI).
fn git_supports_diff_algorithm(dir: &Path) -> bool {
    for name in ["base", "ours", "theirs"] {
        std::fs::write(dir.join(name), "x\n").unwrap();
    }
    Command::new("/usr/bin/git")
        .args([
            "merge-file",
            "-p",
            "--diff-algorithm=histogram",
            "ours",
            "base",
            "theirs",
        ])
        .current_dir(dir)
        .output()
        .is_ok_and(|output| output.status.success())
}

#[test]
fn three_way_merge_matches_git_merge_file() {
    let dir = tempfile::tempdir().unwrap();
    if !git_supports_diff_algorithm(dir.path()) {
        eprintln!("skipped: /usr/bin/git lacks merge-file --diff-algorithm (needs Git 2.44+)");
        return;
    }
    let mut rng = Lcg(7);
    let (mut agree, mut clean) = (0, 0);
    for case in 0..300 {
        let base: Vec<String> = (0..20).map(|i| format!("line {i}")).collect();
        let ours = edit(&base, &mut rng, "ours");
        let theirs = edit(&base, &mut rng, "theirs");
        let join = |lines: &[String]| lines.iter().map(|l| format!("{l}\n")).collect::<String>();
        let (b, o, t) = (join(&base), join(&ours), join(&theirs));
        let (git_clean, git_out) = git_merge(dir.path(), &b, &o, &t);
        let ours_result = merge3(b.as_bytes(), o.as_bytes(), t.as_bytes());
        match (&ours_result, git_clean) {
            (TextMerge::Clean(bytes), true) => {
                assert_eq!(String::from_utf8_lossy(bytes), git_out, "case {case}");
                clean += 1;
            }
            (TextMerge::Conflict { .. }, false) => {}
            (result, _) => panic!(
                "case {case} disagrees: ours={result:?} git_clean={git_clean}\nbase:\n{b}\nours:\n{o}\ntheirs:\n{t}"
            ),
        }
        agree += 1;
    }
    assert_eq!(agree, 300);
    assert!(
        clean > 50,
        "the corpus should exercise clean merges too ({clean})"
    );
}
