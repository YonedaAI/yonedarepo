//! Review classes (semantic approval): each changed file is classified so policy can
//! auto-approve noise and focus human review on consequential edits. Code files compare
//! token streams with comments and layout removed; anything the lexer cannot read
//! (unterminated strings or comments, binary, unknown languages) is `unknown`, which is
//! never safe.
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
    /// `#` comments; quotes `"` and `'`.
    Hash,
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
        "py" | "sh" | "bash" | "zsh" | "rb" | "toml" | "yaml" | "yml" | "pl" | "r" => Syntax::Hash,
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

/// Splits source into code tokens and comment texts, or fails on unterminated input.
fn lex(source: &str, syntax: Syntax) -> Result<(Vec<String>, Vec<String>), ()> {
    let chars: Vec<char> = source.chars().collect();
    let (mut tokens, mut comments) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c.is_whitespace() {
            i += 1;
        } else if matches!(syntax, Syntax::CLike { .. }) && c == '/' && next == Some('/')
            || syntax == Syntax::Hash && c == '#'
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

/// Classifies one file change (`None` content: absent side).
pub fn classify(path: &str, old: Option<&[u8]>, new: Option<&[u8]>) -> ReviewClass {
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
        classify(path, Some(old.as_bytes()), Some(new.as_bytes()))
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
        assert_eq!(classify("a.rs", Some(b"\0\x01"), Some(b"\0\x02")), Unknown);
        assert_eq!(classify("a.rs", None, Some(b"fn a() {}")), Logic);
    }
}
