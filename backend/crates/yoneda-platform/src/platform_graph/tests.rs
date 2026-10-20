use super::*;

const LIB: &str = "use std::fmt;\n\n/// Retries.\npub fn retry() -> u32 {\n    backoff() + 1\n}\n\npub fn backoff() -> u32 {\n    2\n}\n\npub struct Policy;\n\nimpl Policy {\n    pub fn new() -> Self {\n        Policy\n    }\n\n    pub fn limit(&self) -> u32 {\n        retry()\n    }\n}\n";

#[test]
fn edits_inside_one_function_touch_only_that_function() {
    let edited = LIB.replace("backoff() + 1", "backoff() + 2");
    assert_eq!(
        touched("src/lib.rs", LIB, &edited),
        Some(vec!["retry".into()])
    );
    let method = LIB.replace("        retry()", "        retry() * 2");
    assert_eq!(
        touched("src/lib.rs", LIB, &method),
        Some(vec!["Policy::limit".into()])
    );
}

#[test]
fn added_and_removed_symbols_are_touched_without_widening() {
    let added = LIB.replace(
        "pub struct Policy;",
        "pub fn jitter() -> u32 {\n    0\n}\n\npub struct Policy;",
    );
    assert_eq!(
        touched("src/lib.rs", LIB, &added),
        Some(vec!["jitter".into()])
    );
    let removed = LIB.replace("pub fn backoff() -> u32 {\n    2\n}\n\n", "");
    assert_eq!(
        touched("src/lib.rs", LIB, &removed),
        Some(vec!["backoff".into()])
    );
}

#[test]
fn changes_outside_symbols_or_parse_failures_are_whole_file() {
    let import = LIB.replace("use std::fmt;", "use std::fmt::Write;");
    assert_eq!(touched("src/lib.rs", LIB, &import), None);
    let impl_header = LIB.replace("impl Policy {", "impl Policy where Self: Sized {");
    assert_eq!(touched("src/lib.rs", LIB, &impl_header), None);
    assert_eq!(
        touched("src/lib.rs", LIB, &format!("{LIB}fn broken( {{")),
        None
    );
    assert_eq!(
        touched("src/lib.rs", &format!("{LIB}fn broken( {{"), LIB),
        None
    );
    assert_eq!(touched("README.md", "a", "b"), None);
    // Nothing but whitespace between symbols: no symbol touched, so the whole file.
    assert_eq!(
        touched(
            "src/lib.rs",
            LIB,
            &LIB.replace("\n\npub fn backoff", "\n\n\npub fn backoff")
        ),
        None
    );
}

#[test]
fn a_changed_member_does_not_touch_its_class() {
    let source = "export class Cache {\n  size = 1;\n  get(k: string) { return k; }\n  put(k: string) { return k; }\n}\n";
    let get = source.replace("return k; }\n  put", "return k + 1; }\n  put");
    assert_eq!(
        touched("a.ts", source, &get),
        Some(vec!["Cache::get".into()])
    );
    let field = source.replace("size = 1", "size = 2");
    assert_eq!(touched("a.ts", source, &field), Some(vec!["Cache".into()]));
}

#[test]
fn references_come_from_own_text_only() {
    let file = file_symbols("src/lib.rs", LIB).unwrap();
    let refs = |path: &str| {
        let i = file
            .symbols
            .iter()
            .position(|s| s.symbol_path == path)
            .unwrap();
        file.references[i].iter().cloned().collect::<Vec<_>>()
    };
    assert!(refs("retry").contains(&"backoff".to_string()));
    assert!(
        !refs("retry").contains(&"Retries".to_string()),
        "doc comments are not code"
    );
    assert!(refs("Policy::limit").contains(&"retry".to_string()));

    let script = "export const a = f(), b = g();\nfunction f() { return `${b}`; }\nfunction g() { return 'f'; }\n";
    let file = file_symbols("x.ts", script).unwrap();
    let refs: Vec<(String, Vec<String>)> = file
        .symbols
        .iter()
        .zip(&file.references)
        .map(|(s, r)| (s.symbol_path.clone(), r.iter().cloned().collect()))
        .collect();
    // Both declarators share the statement's range, so both own its identifiers.
    assert!(refs[0].1.contains(&"g".to_string()) && refs[1].1.contains(&"f".to_string()));
    // Template expressions are code; string contents are not.
    assert!(refs[2].1.contains(&"b".to_string()));
    assert!(!refs[3].1.contains(&"f".to_string()));
}

#[test]
fn the_graph_links_symbols_across_files_by_name() {
    let a = file_symbols(
        "a.ts",
        "export function a(n: number): number { return n > 0 ? b(n - 1) : 0; }\n",
    )
    .unwrap();
    let b = file_symbols(
        "b.ts",
        "export function b(n: number): number { return a(n); }\n",
    )
    .unwrap();
    let g = graph(&[a, b], BTreeSet::new());
    assert_eq!(g.nodes.len(), 2);
    assert_eq!(g.edges, vec![vec![1], vec![0]]);
    assert!(file_symbols("c.ts", "function (").is_err());
}
