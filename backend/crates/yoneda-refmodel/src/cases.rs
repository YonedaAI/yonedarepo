//! Seeded random operation sequences: every case is reproducible from its seed.
use crate::{MAIN, Op, Repo};

/// SplitMix64: small, fast and good enough to drive test cases deterministically.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A number in `0..n` (`n > 0`).
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// Files the generator writes: none is another's directory.
pub const PATHS: [&str; 4] = ["README.md", "src/lib.rs", "src/b.rs", "a.txt"];
/// Working branches (and main), and tags.
const BRANCHES: [&str; 4] = [
    MAIN,
    "refs/heads/b1",
    "refs/heads/b2",
    "refs/heads/feature/x",
];
const TAGS: [&str; 3] = ["refs/tags/v1", "refs/tags/v2", "refs/tags/v3"];

/// The next operation for `repo` at `step`: mostly valid, with stale expectations, protected
/// refs and moved tags mixed in. File contents name the step, so every put changes its file.
pub fn generate(rng: &mut Rng, repo: &Repo, step: usize) -> Op {
    let existing: Vec<&str> = BRANCHES
        .iter()
        .copied()
        .filter(|b| repo.tip(b).is_some())
        .collect();
    let any_ref = |rng: &mut Rng| -> String {
        let refs: Vec<&String> = repo.refs.keys().collect();
        rng.pick(&refs).to_string()
    };
    match rng.below(100) {
        0..40 => {
            let branch = rng.pick(&existing).to_string();
            let tree = &repo.commits[repo.refs[&branch]].tree;
            let path = rng.pick(&PATHS).to_string();
            // Deletes only an existing file, and never the last one.
            let delete = tree.contains_key(&path) && tree.len() > 1 && rng.below(4) == 0;
            Op::Commit {
                branch,
                content: (!delete).then(|| format!("{path} at step {step}\n")),
                path,
                read: rng.below(4) == 0,
            }
        }
        40..52 => Op::CreateBranch {
            name: rng.pick(&BRANCHES).to_string(),
            from: any_ref(rng),
        },
        52..62 => Op::MoveBranch {
            name: rng.pick(&existing).to_string(),
            to: any_ref(rng),
            expected: any_ref(rng),
        },
        62..70 => {
            let name = rng.pick(&BRANCHES).to_string();
            // Mostly the right expectation, so deletions happen.
            let expected = if rng.below(3) == 0 {
                any_ref(rng)
            } else {
                name.clone()
            };
            Op::DeleteBranch { name, expected }
        }
        70..80 => Op::Tag {
            name: rng.pick(&TAGS).to_string(),
            at: any_ref(rng),
        },
        _ => {
            // A working branch when there is one: main onto itself is always a no-op.
            let working: Vec<&str> = existing.iter().copied().filter(|b| *b != MAIN).collect();
            Op::Land {
                branch: rng
                    .pick(if working.is_empty() {
                        &existing
                    } else {
                        &working
                    })
                    .to_string(),
            }
        }
    }
}
