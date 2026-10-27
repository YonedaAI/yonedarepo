//! Agent instruction files: whatever coding agents read as standing orders when they work
//! in the repository. A change to one steers every later agent, so review never treats it
//! as documentation.

/// File names agents load wherever they appear (compared without case: a case-insensitive
/// checkout reads `agents.md` as `AGENTS.md`).
const FILES: [&str; 9] = [
    "agents.md",
    "agents.override.md",
    "claude.md",
    "claude.local.md",
    "gemini.md",
    "skill.md",
    ".cursorrules",
    ".windsurfrules",
    ".clinerules",
];

/// Directories whose whole contents configure an agent, at any depth.
const DIRECTORIES: [&str; 5] = [".claude", ".codex", ".cursor", ".gemini", ".agents"];

/// Repository-root paths, as prefixes: one file or a directory with a trailing `/`.
const ROOTED: [&str; 3] = [
    ".github/copilot-instructions.md",
    ".github/instructions/",
    ".github/prompts/",
];

pub fn is_instructions(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let mut parts = lower.split('/').peekable();
    while let Some(part) = parts.next() {
        let last = parts.peek().is_none();
        if DIRECTORIES.contains(&part) && !last || last && FILES.contains(&part) {
            return true;
        }
    }
    ROOTED.iter().any(|root| lower.starts_with(root))
}
