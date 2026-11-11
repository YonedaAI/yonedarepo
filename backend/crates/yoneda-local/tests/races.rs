//! Many local writers on one branch at the same instant: every push to `main` is released
//! by one barrier, and the service's own timings (`YONEDA_LOCAL_TIMINGS`) prove the
//! receives overlapped there, not only in the clients.
mod support;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Output;
use std::sync::{Arc, Barrier};
use std::time::Instant;
use support::{Local, text};

const WRITERS: usize = 8;

struct Raced {
    outputs: Vec<Output>,
    timings: Vec<Value>,
}

/// `WRITERS` worktrees from the same `main`, each changed by `edit`, pushed to `main`
/// together; `keep` first pushes each to its own branch.
fn race(l: &mut Local, keep: bool, edit: impl Fn(usize) -> (String, String)) -> Raced {
    let timings = l.dir.path().join("timings.jsonl");
    let t = timings.to_str().unwrap().to_owned();
    l.serve_with(&[("YONEDA_LOCAL_TIMINGS", &t)]);
    let trees: Vec<PathBuf> = (0..WRITERS).map(|i| l.worktree(&format!("w{i}"))).collect();
    for (i, wt) in trees.iter().enumerate() {
        let (path, body) = edit(i);
        l.commit(wt, &path, &body);
        if keep {
            let own = format!("HEAD:refs/heads/w{i}");
            let kept = l.git(wt, &["push", "-q", "local", &own]);
            assert!(kept.status.success(), "{}", text(&kept));
        }
    }
    std::fs::remove_file(&timings).ok();
    let gate = Arc::new(Barrier::new(WRITERS));
    let pushes: Vec<_> = trees
        .iter()
        .map(|wt| {
            let mut cmd = l.push_command(wt, &[]);
            let gate = gate.clone();
            std::thread::spawn(move || {
                gate.wait();
                cmd.output().unwrap()
            })
        })
        .collect();
    let outputs = pushes.into_iter().map(|p| p.join().unwrap()).collect();
    Raced {
        outputs,
        timings: Local::timings(&timings),
    }
}

/// Every receive started at the service before the first push finished there.
fn overlapped(timings: &[Value]) {
    let pushes: Vec<&Value> = timings
        .iter()
        .filter(|t| t["ref"] == "refs/heads/main")
        .collect();
    assert_eq!(pushes.len(), WRITERS, "{timings:?}");
    let last_start = pushes
        .iter()
        .map(|t| t["start_ms"].as_u64().unwrap())
        .max()
        .unwrap();
    let first_end = pushes
        .iter()
        .map(|t| t["start_ms"].as_u64().unwrap() + t["ms"]["total"].as_u64().unwrap())
        .min()
        .unwrap();
    assert!(
        last_start <= first_end,
        "pushes did not overlap at the service: last start {last_start}, first end {first_end}"
    );
}

fn landed(r: &Raced) -> Vec<usize> {
    (0..WRITERS)
        .filter(|&i| r.outputs[i].status.success())
        .collect()
}

/// Disjoint files: all land; one fast-forwards and every other is a platform merge.
#[test]
fn simultaneous_disjoint_pushes_all_land() {
    let mut l = Local::new();
    let r = race(&mut l, false, |i| {
        (format!("w{i}.txt"), format!("writer {i}\n"))
    });
    overlapped(&r.timings);
    assert_eq!(
        landed(&r),
        (0..WRITERS).collect::<Vec<_>>(),
        "{:?}",
        r.outputs.iter().map(text).collect::<Vec<_>>()
    );
    let merged = r
        .outputs
        .iter()
        .filter(|o| text(o).contains("landed with server merge"))
        .count();
    assert_eq!(merged, WRITERS - 1);
    for i in 0..WRITERS {
        assert_eq!(l.show(&format!("main:w{i}.txt")), format!("writer {i}"));
    }
    assert_eq!(l.status()["main"], l.store_ref("main"));
    l.git_ok(&l.store(), &["fsck", "--strict", "--no-dangling"]);
}

/// Different lines of one file: all land and the file holds every edit.
#[test]
fn simultaneous_edits_to_different_lines_of_one_file_merge() {
    let mut l = Local::uninitialized("clone", &[]);
    l.seed();
    let spaced: String = (0..WRITERS).map(|i| format!("line {i}\n\n\n\n")).collect();
    l.write(&l.clone, "spaced.txt", &spaced);
    l.git_ok(&l.clone, &["add", "spaced.txt"]);
    l.git_ok(&l.clone, &["commit", "-qm", "spaced"]);
    l.run_ok(&l.clone, &["init"]);
    let r = race(&mut l, false, |i| {
        let body: String = (0..WRITERS)
            .map(|j| {
                if j == i {
                    format!("LINE {j} by writer {i}\n\n\n\n")
                } else {
                    format!("line {j}\n\n\n\n")
                }
            })
            .collect();
        ("spaced.txt".into(), body)
    });
    overlapped(&r.timings);
    assert_eq!(
        landed(&r).len(),
        WRITERS,
        "{:?}",
        r.outputs.iter().map(text).collect::<Vec<_>>()
    );
    let merged = l.show("main:spaced.txt");
    for i in 0..WRITERS {
        assert!(
            merged.contains(&format!("LINE {i} by writer {i}")),
            "{merged}"
        );
    }
    l.git_ok(&l.store(), &["fsck", "--strict", "--no-dangling"]);
}

/// The same line: exactly one lands; every other is refused naming the file, `main` is the
/// winner's commit and each loser's own branch is kept.
#[test]
fn simultaneous_same_line_pushes_land_exactly_one() {
    let mut l = Local::new();
    let r = race(&mut l, true, |i| {
        ("list.txt".into(), format!("writer {i}\ntwo\nthree\n"))
    });
    overlapped(&r.timings);
    let won = landed(&r);
    assert_eq!(
        won.len(),
        1,
        "{:?}",
        r.outputs.iter().map(text).collect::<Vec<_>>()
    );
    let winner = won[0];
    for i in (0..WRITERS).filter(|&i| i != winner) {
        let said = text(&r.outputs[i]);
        assert!(said.contains("conflict in list.txt"), "writer {i}: {said}");
        let own = l.store_ref(&format!("w{i}"));
        assert_eq!(
            l.git_ok(&l.store(), &["show", &format!("{own}:list.txt")])
                .lines()
                .next()
                .unwrap(),
            format!("writer {i}")
        );
    }
    assert_eq!(
        l.show("main:list.txt").lines().next().unwrap(),
        format!("writer {winner}")
    );
    assert_eq!(l.status()["main"], l.store_ref("main"));
    l.git_ok(&l.store(), &["fsck", "--strict", "--no-dangling"]);
}

/// Half on the same line, half on their own files: one of the first half and all of the
/// second land.
#[test]
fn mixed_conflicting_and_disjoint_pushes() {
    let mut l = Local::new();
    let half = WRITERS / 2;
    let r = race(&mut l, false, |i| {
        if i < half {
            ("list.txt".into(), format!("writer {i}\ntwo\nthree\n"))
        } else {
            (format!("w{i}.txt"), format!("writer {i}\n"))
        }
    });
    overlapped(&r.timings);
    let won = landed(&r);
    assert_eq!(
        won.iter().filter(|&&i| i < half).count(),
        1,
        "{:?}",
        r.outputs.iter().map(text).collect::<Vec<_>>()
    );
    for i in half..WRITERS {
        assert!(won.contains(&i), "writer {i}: {}", text(&r.outputs[i]));
        assert_eq!(l.show(&format!("main:w{i}.txt")), format!("writer {i}"));
    }
    l.git_ok(&l.store(), &["fsck", "--strict", "--no-dangling"]);
}

/// Off by default: no timings are written.
#[test]
fn timings_are_off_unless_switched_on() {
    let mut l = Local::new();
    l.serve();
    let a = l.worktree("wt-a");
    l.commit(&a, "a.txt", "a changed\n");
    assert!(l.push(&a, &[]).status.success());
    let any = std::fs::read_dir(l.clone.join(".git/yoneda/local"))
        .unwrap()
        .any(|e| e.unwrap().file_name().to_string_lossy().contains("timing"));
    assert!(!any);
}

/// Write speed of the local service alone (unpaired, so no cloud in the path): 1, 4 and 16
/// writers on disjoint files, 3 runs each. Prints client and server milliseconds
/// (min/median/max) and landings per second. `cargo test -p yoneda-local --test races --
/// --ignored --nocapture write_speed`.
#[test]
#[ignore = "benchmark: run explicitly"]
fn write_speed() {
    let mut rows = Vec::new();
    for writers in [1usize, 4, 16] {
        for run in 1..=3 {
            let mut l = Local::new();
            let timings = l.dir.path().join("timings.jsonl");
            let t = timings.to_str().unwrap().to_owned();
            l.serve_with(&[("YONEDA_LOCAL_TIMINGS", &t)]);
            let trees: Vec<PathBuf> = (0..writers).map(|i| l.worktree(&format!("w{i}"))).collect();
            for (i, wt) in trees.iter().enumerate() {
                l.commit(wt, &format!("w{i}.txt"), &format!("writer {i}\n"));
            }
            std::fs::remove_file(&timings).ok();
            let gate = Arc::new(Barrier::new(writers));
            let began = Instant::now();
            let pushes: Vec<_> = trees
                .iter()
                .map(|wt| {
                    let mut cmd = l.push_command(wt, &[]);
                    let gate = gate.clone();
                    std::thread::spawn(move || {
                        gate.wait();
                        let start = Instant::now();
                        let out = cmd.output().unwrap();
                        (out, start.elapsed().as_millis() as u64)
                    })
                })
                .collect();
            let client: Vec<(Output, u64)> =
                pushes.into_iter().map(|p| p.join().unwrap()).collect();
            let wall = began.elapsed().as_secs_f64();
            for (out, _) in &client {
                assert!(out.status.success(), "a push failed: {}", text(out));
            }
            let server: Vec<u64> = Local::timings(&timings)
                .iter()
                .filter(|t| t["ref"] == "refs/heads/main")
                .map(|t| t["ms"]["total"].as_u64().unwrap())
                .collect();
            let land: Vec<u64> = Local::timings(&timings)
                .iter()
                .map(|t| t["ms"]["land"].as_u64().unwrap())
                .collect();
            let row = serde_json::json!({
                "writers": writers, "run": run,
                "client_ms": spread(client.iter().map(|c| c.1).collect()),
                "server_ms": spread(server), "land_ms": spread(land),
                "landings_per_s": (writers as f64 / wall * 10.0).round() / 10.0,
            });
            println!("{row}");
            rows.push(row);
        }
    }
    if let Ok(out) = std::env::var("YONEDA_LOCAL_BENCH_OUT") {
        std::fs::write(out, serde_json::to_string_pretty(&rows).unwrap()).unwrap();
    }
}

fn spread(mut v: Vec<u64>) -> Value {
    v.sort_unstable();
    serde_json::json!({ "min": v[0], "median": v[v.len() / 2], "max": v[v.len() - 1] })
}

/// Git's background maintenance races simultaneous pushes, so `serve` turns it off, also
/// in a store an older version made without those settings.
#[test]
fn serve_turns_off_background_maintenance_in_an_existing_store() {
    let mut l = Local::new();
    for key in ["receive.autogc", "maintenance.auto"] {
        l.git_ok(&l.store(), &["config", "--unset", key]);
    }
    l.serve();
    for key in ["receive.autogc", "maintenance.auto"] {
        assert_eq!(l.git_ok(&l.store(), &["config", "--get", key]), "false");
    }
}
