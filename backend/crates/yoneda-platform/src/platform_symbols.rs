//! Symbol extraction with pure-Rust parsers (syn for Rust, oxc for TypeScript and
//! JavaScript), so it runs as stateless compute in the Worker. Results depend only on a
//! blob's content and language, so they are cached by blob id. A parse failure is
//! reported as such and is never treated as "no symbols" or "safe".
use proc_macro2::Span;
use serde::Serialize;
use syn::spanned::Spanned;

/// Bump when extraction output changes, so cached results are not reused.
pub const EXTRACTOR_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Rust,
    Script,
}

pub fn language(path: &str) -> Option<Language> {
    let ext = path.rsplit_once('.').map(|(_, e)| e)?;
    match ext {
        "rs" => Some(Language::Rust),
        "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => Some(Language::Script),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Symbol {
    pub name: String,
    pub kind: &'static str,
    /// Qualified path within the file, e.g. `Retry::backoff` or `mod::fn`.
    pub symbol_path: String,
    pub start: usize,
    pub end: usize,
    pub start_line: usize,
    pub end_line: usize,
}

fn line_of(source: &str, offset: usize) -> usize {
    source.as_bytes()[..offset.min(source.len())]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

fn symbol(
    source: &str,
    name: String,
    kind: &'static str,
    prefix: &str,
    start: usize,
    end: usize,
) -> Symbol {
    Symbol {
        symbol_path: if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}::{name}")
        },
        name,
        kind,
        start,
        end,
        start_line: line_of(source, start),
        end_line: line_of(source, end.saturating_sub(1)),
    }
}

/// Symbols in `source`, or the parser's error.
pub fn extract(path: &str, source: &str) -> Result<Vec<Symbol>, String> {
    match language(path) {
        Some(Language::Rust) => rust(source),
        Some(Language::Script) => script(path, source),
        None => Ok(Vec::new()),
    }
}

fn rust(source: &str) -> Result<Vec<Symbol>, String> {
    let result = syn::parse_file(source)
        .map_err(|e| e.to_string())
        .map(|file| {
            let mut out = Vec::new();
            rust_items(source, &file.items, "", &mut out);
            out
        });
    // span-locations keeps every parsed file in a thread-local map; a long-lived Worker
    // isolate must release it after each extraction (no syn values outlive this call).
    proc_macro2::extra::invalidate_current_thread_spans();
    result
}

fn range(span: Span) -> (usize, usize) {
    let r = span.byte_range();
    (r.start, r.end)
}

fn rust_items(source: &str, items: &[syn::Item], prefix: &str, out: &mut Vec<Symbol>) {
    use syn::{ImplItem, Item, TraitItem};
    for item in items {
        let (start, end) = range(item.span());
        let mut push =
            |name: String, kind| out.push(symbol(source, name, kind, prefix, start, end));
        match item {
            Item::Fn(f) => push(f.sig.ident.to_string(), "function"),
            Item::Struct(s) => push(s.ident.to_string(), "struct"),
            Item::Enum(e) => push(e.ident.to_string(), "enum"),
            Item::Const(c) => push(c.ident.to_string(), "const"),
            Item::Static(s) => push(s.ident.to_string(), "static"),
            Item::Type(t) => push(t.ident.to_string(), "type"),
            Item::Trait(t) => {
                push(t.ident.to_string(), "trait");
                let inner = if prefix.is_empty() {
                    t.ident.to_string()
                } else {
                    format!("{prefix}::{}", t.ident)
                };
                for member in &t.items {
                    if let TraitItem::Fn(f) = member {
                        let (s, e) = range(member.span());
                        out.push(symbol(
                            source,
                            f.sig.ident.to_string(),
                            "method",
                            &inner,
                            s,
                            e,
                        ));
                    }
                }
            }
            Item::Impl(i) => {
                let target = match &*i.self_ty {
                    syn::Type::Path(p) => p.path.segments.last().map(|s| s.ident.to_string()),
                    _ => None,
                }
                .unwrap_or_else(|| "impl".into());
                let inner = if prefix.is_empty() {
                    target
                } else {
                    format!("{prefix}::{target}")
                };
                for member in &i.items {
                    if let ImplItem::Fn(f) = member {
                        let (s, e) = range(member.span());
                        out.push(symbol(
                            source,
                            f.sig.ident.to_string(),
                            "method",
                            &inner,
                            s,
                            e,
                        ));
                    }
                }
            }
            Item::Mod(m) => {
                push(m.ident.to_string(), "module");
                if let Some((_, nested)) = &m.content {
                    let inner = if prefix.is_empty() {
                        m.ident.to_string()
                    } else {
                        format!("{prefix}::{}", m.ident)
                    };
                    rust_items(source, nested, &inner, out);
                }
            }
            _ => {}
        }
    }
}

fn script(path: &str, source: &str) -> Result<Vec<Symbol>, String> {
    use oxc_allocator::Allocator;
    use oxc_ast::ast::{ClassElement, Declaration, ExportDefaultDeclarationKind, Statement};
    use oxc_parser::Parser;
    use oxc_span::SourceType;
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|e| format!("{e:?}"))?;
    // The same parser configuration as `platform_facts_script`, so one parser is compiled.
    let parsed = Parser::new(&allocator, source, source_type)
        .with_config(oxc_parser::config::TokensParserConfig)
        .parse();
    if parsed.fatal_error || parsed.diagnostics.has_errors() {
        return Err("Syntax error".into());
    }
    let mut out = Vec::new();
    let span = |s: oxc_span::Span| (s.start as usize, s.end as usize);
    let declaration = |decl: &Declaration, outer: Option<oxc_span::Span>, out: &mut Vec<Symbol>| {
        let pick = |inner: oxc_span::Span| span(outer.unwrap_or(inner));
        match decl {
            Declaration::FunctionDeclaration(f) => {
                if let Some(id) = &f.id {
                    let (s, e) = pick(f.span);
                    out.push(symbol(
                        source,
                        id.name.as_str().into(),
                        "function",
                        "",
                        s,
                        e,
                    ));
                }
            }
            Declaration::ClassDeclaration(c) => {
                let Some(id) = &c.id else { return };
                let (s, e) = pick(c.span);
                let class = id.name.as_str().to_owned();
                out.push(symbol(source, class.clone(), "class", "", s, e));
                for element in &c.body.body {
                    if let ClassElement::MethodDefinition(m) = element
                        && let Some(name) = m.key.static_name().and_then(|name| name.into_cow_str())
                    {
                        let (ms, me) = span(m.span);
                        out.push(symbol(source, name.into_owned(), "method", &class, ms, me));
                    }
                }
            }
            Declaration::VariableDeclaration(v) => {
                for d in &v.declarations {
                    if let Some(name) = d.id.get_identifier_name() {
                        let (s, e) = pick(v.span);
                        out.push(symbol(source, name.as_str().into(), "variable", "", s, e));
                    }
                }
            }
            Declaration::TSInterfaceDeclaration(i) => {
                let (s, e) = pick(i.span);
                out.push(symbol(
                    source,
                    i.id.name.as_str().into(),
                    "interface",
                    "",
                    s,
                    e,
                ));
            }
            Declaration::TSTypeAliasDeclaration(t) => {
                let (s, e) = pick(t.span);
                out.push(symbol(source, t.id.name.as_str().into(), "type", "", s, e));
            }
            Declaration::TSEnumDeclaration(t) => {
                let (s, e) = pick(t.span);
                out.push(symbol(source, t.id.name.as_str().into(), "enum", "", s, e));
            }
            _ => {}
        }
    };
    for statement in &parsed.program.body {
        match statement {
            Statement::ExportDeclaration(export) => {
                declaration(&export.declaration, Some(export.span), &mut out);
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                    let name =
                        f.id.as_ref()
                            .map_or("default".into(), |id| id.name.as_str().to_owned());
                    let (s, e) = span(export.span);
                    out.push(symbol(source, name, "function", "", s, e));
                }
                ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                    let name =
                        c.id.as_ref()
                            .map_or("default".into(), |id| id.name.as_str().to_owned());
                    let (s, e) = span(export.span);
                    out.push(symbol(source, name, "class", "", s, e));
                }
                _ => {}
            },
            other => {
                if let Some(decl) = other.as_declaration() {
                    declaration(decl, None, &mut out);
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUST: &str = "/// Retries with backoff.\npub fn retry() -> u32 {\n    1\n}\n\npub struct Policy;\n\nimpl Policy {\n    pub fn backoff(&self) -> u32 { 2 }\n}\n\nmod inner {\n    fn helper() {}\n}\n";

    #[test]
    fn extracts_rust_items_with_exact_byte_ranges() {
        let symbols = extract("src/lib.rs", RUST).unwrap();
        let paths: Vec<&str> = symbols.iter().map(|s| s.symbol_path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "retry",
                "Policy",
                "Policy::backoff",
                "inner",
                "inner::helper"
            ]
        );
        let retry = &symbols[0];
        assert_eq!(
            &RUST[retry.start..retry.end],
            "/// Retries with backoff.\npub fn retry() -> u32 {\n    1\n}"
        );
        assert_eq!((retry.start_line, retry.end_line), (1, 4));
        let backoff = &symbols[2];
        assert_eq!(
            &RUST[backoff.start..backoff.end],
            "pub fn backoff(&self) -> u32 { 2 }"
        );
    }

    #[test]
    fn extracts_typescript_declarations_and_methods() {
        let source = "export function load(id: string) { return id; }\nclass Cache {\n  get(key: string) { return key; }\n}\nexport interface Options { retries: number }\nconst limit = 3;\nexport default class Main {}\n";
        let symbols = extract("src/app.ts", source).unwrap();
        let paths: Vec<(&str, &str)> = symbols
            .iter()
            .map(|s| (s.symbol_path.as_str(), s.kind))
            .collect();
        assert_eq!(
            paths,
            [
                ("load", "function"),
                ("Cache", "class"),
                ("Cache::get", "method"),
                ("Options", "interface"),
                ("limit", "variable"),
                ("Main", "class")
            ]
        );
        assert_eq!(
            &source[symbols[0].start..symbols[0].end],
            "export function load(id: string) { return id; }"
        );
    }

    #[test]
    fn repeated_parses_keep_offsets_relative_to_each_file() {
        for _ in 0..3 {
            extract("x.rs", RUST).unwrap();
        }
        let source = "fn second() {}\n";
        let symbols = extract("y.rs", source).unwrap();
        assert_eq!(&source[symbols[0].start..symbols[0].end], "fn second() {}");
    }

    #[test]
    fn syntax_errors_are_failures_not_empty_results() {
        assert!(extract("a.rs", "fn broken( {").is_err());
        assert!(extract("a.ts", "function (").is_err());
        assert_eq!(extract("README.md", "# hi").unwrap(), vec![]);
    }
}
