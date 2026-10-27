//! Review classes (semantic approval): each changed file is classified so policy can
//! auto-approve noise and focus human review on consequential edits. Code files compare
//! token streams with comments and insignificant layout removed; anything the lexer cannot
//! read (unterminated strings or comments, binary, unknown languages), a mode change, an
//! executable or a symlink is `unknown`, which is never safe. Agent instruction files steer
//! every later agent, so they are `instructions`, never `docs`.
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewClass {
    /// Documentation files only.
    Docs,
    /// Whitespace/layout only: tokens and comments identical.
    Formatting,
    /// Comments changed; code tokens identical.
    CommentOnly,
    /// Code tokens changed (including added/removed code files).
    Logic,
    /// Agent instructions (`AGENTS.md`, `CLAUDE.md`, `.claude/**`, skills, ...).
    Instructions,
    /// Could not be classified; requires a human.
    Unknown,
}

impl ReviewClass {
    pub const AUTO_APPROVABLE: [&'static str; 3] = ["docs", "formatting", "comment_only"];
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Syntax {
    /// `//`, `/* */` comments; quotes `"`, `'`, `` ` ``.
    CLike { nested: bool, rust: bool },
    /// `#` comments (at a line start or after whitespace); quotes `"` and `'`.
    Hash(Layout),
}

/// Which whitespace carries meaning. Trailing whitespace and blank lines never do.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Layout {
    /// Only where it keeps two operator characters apart (`+ +` is not `++`).
    Free,
    /// Also a line's indentation (Python blocks).
    Indent,
    /// Every run inside a line (YAML nesting and plain scalars, shell words).
    Exact,
}

fn syntax(path: &str) -> Option<Syntax> {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
    Some(match ext.as_str() {
        "rs" => Syntax::CLike {
            nested: true,
            rust: true,
        },
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" | "go" | "java" | "c" | "h"
        | "cc" | "cpp" | "hpp" | "cs" | "kt" | "swift" | "scala" | "css" | "scss" => {
            Syntax::CLike {
                nested: false,
                rust: false,
            }
        }
        "py" => Syntax::Hash(Layout::Indent),
        "sh" | "bash" | "zsh" | "rb" | "yaml" | "yml" | "pl" => Syntax::Hash(Layout::Exact),
        "toml" | "r" => Syntax::Hash(Layout::Free),
        _ => return None,
    })
}

fn is_docs(path: &str) -> bool {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "md" | "mdx" | "markdown" | "rst" | "txt" | "adoc"
    )
}

/// Whether a comment starts at `i`.
fn comment_at(chars: &[char], i: usize, syntax: Syntax) -> bool {
    match syntax {
        Syntax::CLike { .. } => chars[i] == '/' && matches!(chars.get(i + 1), Some('/' | '*')),
        Syntax::Hash(_) => chars[i] == '#' && (i == 0 || chars[i - 1].is_whitespace()),
    }
}

const OPERATORS: &str = "+-*/%<>=!&|^~:.?";

/// The token a whitespace run `[start, end)` leaves, if its layout makes it significant.
fn whitespace(chars: &[char], start: usize, end: usize, syntax: Syntax) -> Option<String> {
    if end == chars.len() || chars[end] == '\n' || comment_at(chars, end, syntax) {
        return None; // trailing
    }
    let layout = match syntax {
        Syntax::CLike { .. } => Layout::Free,
        Syntax::Hash(layout) => layout,
    };
    let line_start = start == 0 || chars[start - 1] == '\n';
    let joins = |c: Option<&char>| c.is_some_and(|c| OPERATORS.contains(*c));
    let significant = match layout {
        Layout::Exact => true,
        Layout::Indent if line_start => true,
        _ => !line_start && joins(chars.get(start.wrapping_sub(1))) && joins(chars.get(end)),
    };
    significant.then(|| chars[start..end].iter().collect())
}

/// Splits source into code tokens and comment texts, or fails on unterminated input.
fn lex(source: &str, syntax: Syntax) -> Result<(Vec<String>, Vec<String>), ()> {
    let chars: Vec<char> = source.chars().collect();
    let (mut tokens, mut comments) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '\n' {
            i += 1;
        } else if c.is_whitespace() {
            let start = i;
            while i < chars.len() && chars[i].is_whitespace() && chars[i] != '\n' {
                i += 1;
            }
            tokens.extend(whitespace(&chars, start, i, syntax));
        } else if matches!(syntax, Syntax::CLike { .. }) && c == '/' && next == Some('/')
            || matches!(syntax, Syntax::Hash(_)) && comment_at(&chars, i, syntax)
        {
            let start = i;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            comments.push(
                chars[start..i]
                    .iter()
                    .collect::<String>()
                    .trim_end()
                    .to_owned(),
            );
        } else if let Syntax::CLike { nested, .. } = syntax
            && c == '/'
            && next == Some('*')
        {
            let start = i;
            let mut depth = 0;
            loop {
                match (chars.get(i), chars.get(i + 1)) {
                    (Some('/'), Some('*')) if depth == 0 || nested => {
                        depth += 1;
                        i += 2;
                    }
                    (Some('*'), Some('/')) => {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    }
                    (Some(_), _) => i += 1,
                    (None, _) => return Err(()),
                }
            }
            comments.push(chars[start..i].iter().collect());
        } else if c == '"' || c == '`' || (c == '\'' && !rust_lifetime(&chars, i, syntax)) {
            let start = i;
            i += 1;
            loop {
                match chars.get(i) {
                    Some('\\') => i += 2,
                    Some(q) if *q == c => {
                        i += 1;
                        break;
                    }
                    Some(_) => i += 1,
                    None => return Err(()),
                }
            }
            tokens.push(chars[start..i].iter().collect());
        } else if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect());
        } else {
            tokens.push(c.to_string());
            i += 1;
        }
    }
    Ok((tokens, comments))
}

/// In Rust, `'a` (lifetime or label) is not a character literal.
fn rust_lifetime(chars: &[char], i: usize, syntax: Syntax) -> bool {
    let Syntax::CLike { rust: true, .. } = syntax else {
        return false;
    };
    let ident = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric() || *c == '_');
    ident(chars.get(i + 1)) && chars.get(i + 2) != Some(&'\'') && chars.get(i + 1) != Some(&'\\')
}

/// Classifies one file change: `mode` is the new side's (`blob`, `exec`, `symlink`; `None`
/// when deleted) and `None` content an absent side. A change keeps the same content only
/// when it changes the mode.
pub fn classify(
    path: &str,
    mode: Option<&str>,
    old: Option<&[u8]>,
    new: Option<&[u8]>,
) -> ReviewClass {
    if crate::platform_instructions::is_instructions(path) {
        return ReviewClass::Instructions;
    }
    if matches!(mode, Some("exec" | "symlink")) || (old.is_some() && old == new) {
        return ReviewClass::Unknown;
    }
    if is_docs(path) {
        return ReviewClass::Docs;
    }
    let Some(syntax) = syntax(path) else {
        return ReviewClass::Unknown;
    };
    let text = |data: Option<&[u8]>| -> Result<Option<String>, ()> {
        match data {
            None => Ok(None),
            Some(d) if yoneda_core::textdiff::is_binary(d) => Err(()),
            Some(d) => String::from_utf8(d.to_vec()).map(Some).map_err(|_| ()),
        }
    };
    let (Ok(old), Ok(new)) = (text(old), text(new)) else {
        return ReviewClass::Unknown;
    };
    let (Some(old), Some(new)) = (old, new) else {
        return ReviewClass::Logic; // added or removed code
    };
    match (lex(&old, syntax), lex(&new, syntax)) {
        (Ok((old_tokens, old_comments)), Ok((new_tokens, new_comments))) => {
            if old_tokens != new_tokens {
                ReviewClass::Logic
            } else if old_comments != new_comments {
                ReviewClass::CommentOnly
            } else {
                ReviewClass::Formatting
            }
        }
        _ => ReviewClass::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ReviewClass::*;

    fn c(path: &str, old: &str, new: &str) -> ReviewClass {
        classify(
            path,
            Some("blob"),
            Some(old.as_bytes()),
            Some(new.as_bytes()),
        )
    }

    #[test]
    fn separates_comments_layout_and_logic() {
        let base = "fn a() -> u32 {\n    // one\n    1\n}\n";
        assert_eq!(
            c("a.rs", base, &base.replace("// one", "// the answer")),
            CommentOnly
        );
        assert_eq!(
            c("a.rs", base, &base.replace("    1", "        1")),
            Formatting
        );
        assert_eq!(c("a.rs", base, &base.replace("    1", "    2")), Logic);
        assert_eq!(
            c(
                "a.ts",
                "const s = \"// not a comment\";\n",
                "const s = \"// changed\";\n"
            ),
            Logic
        );
        assert_eq!(c("a.py", "x = 1  # one\n", "x = 1  # uno\n"), CommentOnly);
        assert_eq!(c("README.md", "a", "b"), Docs);
        assert_eq!(
            c(
                "a.rs",
                "fn f<'a>(x: &'a str) {} /* c */",
                "fn f<'a>(x: &'a str) {} /* d */"
            ),
            CommentOnly
        );
    }

    #[test]
    fn unreadable_input_is_unknown_never_safe() {
        assert_eq!(
            c("a.rs", "fn a() {}\n", "fn a() {} /* unterminated\n"),
            Unknown
        );
        assert_eq!(c("a.ts", "let s = 'x';\n", "let s = 'x;\n"), Unknown);
        assert_eq!(c("data.bin", "a", "b"), Unknown);
        assert_eq!(
            classify("a.rs", Some("blob"), Some(b"\0\x01"), Some(b"\0\x02")),
            Unknown
        );
        assert_eq!(
            classify("a.rs", Some("blob"), None, Some(b"fn a() {}")),
            Logic
        );
    }

    #[test]
    fn agent_instructions_are_never_docs() {
        for path in [
            "AGENTS.md",
            "agents.md",
            "web/AGENTS.md",
            "AGENTS.override.md",
            "CLAUDE.md",
            "docs/CLAUDE.md",
            "GEMINI.md",
            ".claude/settings.json",
            ".claude/commands/ship.md",
            "app/.claude/agents/x.md",
            ".codex/config.toml",
            ".cursor/rules/style.mdc",
            ".cursorrules",
            ".github/copilot-instructions.md",
            ".github/instructions/ts.instructions.md",
            "skills/deploy/SKILL.md",
        ] {
            assert_eq!(c(path, "a\n", "b\n"), Instructions, "{path}");
            assert_eq!(
                classify(path, Some("blob"), None, Some(b"new\n")),
                Instructions,
                "{path}"
            );
        }
        assert!(!ReviewClass::AUTO_APPROVABLE.contains(&"instructions"));
        assert_eq!(c("README.md", "a\n", "b\n"), Docs);
        assert_eq!(c("docs/agents-overview.md", "a\n", "b\n"), Docs);
    }

    #[test]
    fn significant_whitespace_is_never_formatting() {
        // Python indentation moves a statement into or out of a block.
        let py = "if x:\n    a()\nb()\n";
        assert_eq!(c("a.py", py, &py.replace("\nb()", "\n    b()")), Logic);
        assert_eq!(c("a.py", py, &py.replace("    a()", "\ta()")), Logic);
        assert_eq!(c("a.py", "x=1\n", "x = 1   \n\n"), Formatting);
        // YAML nesting and plain scalars keep their spaces.
        assert_eq!(c("ci.yml", "a:\n  b: 1\n", "a:\nb: 1\n"), Logic);
        assert_eq!(c("ci.yaml", "k: a b\n", "k: a  b\n"), Logic);
        assert_eq!(c("ci.yml", "k: v # c\n", "k: v   # d  \n"), CommentOnly);
        // A `#` inside a word is not a comment.
        assert_eq!(c("ci.yml", "u: http://x#a\n", "u: http://x#b\n"), Logic);
        // Shell assignment versus a command named `x`.
        assert_eq!(c("run.sh", "x=1\n", "x =1\n"), Logic);
        // Operators that whitespace kept apart.
        assert_eq!(c("a.c", "y = a + +b;\n", "y = a ++b;\n"), Logic);
        assert_eq!(c("a.rs", "if x {\n}\n", "if x  {\n\n}\n"), Formatting);
        assert_eq!(c("Makefile", "a:\n\tb\n", "a:\n    b\n"), Unknown);
    }

    #[test]
    fn mode_changes_are_unknown() {
        let body = Some(b"echo hi\n".as_slice());
        // Same content: only the mode changed, in either direction.
        assert_eq!(classify("run.sh", Some("exec"), body, body), Unknown);
        assert_eq!(classify("run.sh", Some("blob"), body, body), Unknown);
        assert_eq!(classify("notes.md", Some("exec"), body, body), Unknown);
        // Executables and symlinks are never layout or prose.
        let edited = Some(b"echo hi # greet\n".as_slice());
        assert_eq!(classify("run.sh", Some("exec"), body, edited), Unknown);
        assert_eq!(classify("doc.md", Some("symlink"), body, edited), Unknown);
        assert_eq!(classify("run.sh", Some("blob"), body, edited), CommentOnly);
    }
}
