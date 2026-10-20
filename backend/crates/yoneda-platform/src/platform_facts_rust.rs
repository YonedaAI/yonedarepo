//! Rust facts (see `platform_facts`): contracts from signatures and rustdoc sections
//! (`# Errors`, `# Panics`, `# Arguments`, `# Returns`, `# Effects`, `# Invariants`) via a
//! syn visitor, and identifier tokens from proc-macro2.
use crate::platform_contracts::{Contract, Failure, FailureKind, Output, Param, rustdoc};
use crate::platform_facts::{Derived, Token};
use proc_macro2::{Span, TokenStream, TokenTree};
use std::str::FromStr;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};

/// Source text of a span, whitespace-collapsed (types and patterns as written).
fn text(source: &str, span: Span) -> String {
    let range = span.byte_range();
    source
        .get(range)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn doc_text(attrs: &[syn::Attribute]) -> String {
    attrs
        .iter()
        .filter(|a| a.path().is_ident("doc"))
        .filter_map(|a| match &a.meta {
            syn::Meta::NameValue(nv) => match &nv.value {
                syn::Expr::Lit(syn::ExprLit {
                    lit: syn::Lit::Str(s),
                    ..
                }) => Some(s.value()),
                _ => None,
            },
            _ => None,
        })
        .map(|line| line.strip_prefix(' ').map(str::to_owned).unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The error type of a `Result<T, E>` return, `None` for a `Result<T>` alias.
fn result_error(ty: &syn::Type, source: &str) -> Option<Option<String>> {
    let syn::Type::Path(path) = ty else {
        return None;
    };
    let last = path.path.segments.last()?;
    if last.ident != "Result" {
        return None;
    }
    let syn::PathArguments::AngleBracketed(args) = &last.arguments else {
        return Some(None);
    };
    let types: Vec<&syn::Type> = args
        .args
        .iter()
        .filter_map(|a| match a {
            syn::GenericArgument::Type(t) => Some(t),
            _ => None,
        })
        .collect();
    Some(types.get(1).map(|e| text(source, e.span())))
}

struct RustFacts<'s> {
    source: &'s str,
    out: Vec<Derived>,
}

impl RustFacts<'_> {
    fn base(&self, attrs: &[syn::Attribute]) -> (Contract, crate::platform_contracts::Doc) {
        let doc = rustdoc(&doc_text(attrs));
        let contract = Contract {
            summary: doc.summary.clone(),
            effects: doc.section(&["Effects", "Side effects"]),
            invariants: doc.section(&["Invariants", "Safety"]),
            errors: doc
                .section(&["Panics"])
                .into_iter()
                .map(|d| Failure {
                    kind: FailureKind::Panic,
                    ty: None,
                    description: Some(d),
                })
                .collect(),
            ..Contract::default()
        };
        (contract, doc)
    }

    fn item(&mut self, attrs: &[syn::Attribute], ident: &syn::Ident) {
        let (contract, _) = self.base(attrs);
        self.out
            .push((ident.span().byte_range().start, ident.to_string(), contract));
    }

    fn function(&mut self, attrs: &[syn::Attribute], sig: &syn::Signature) {
        let (mut contract, doc) = self.base(attrs);
        let described: Vec<(String, Option<String>)> = doc
            .section(&["Arguments", "Parameters"])
            .iter()
            .map(|e| crate::platform_contracts::named(e))
            .collect();
        for input in &sig.inputs {
            match input {
                syn::FnArg::Receiver(r) => match &r.kind {
                    syn::ReceiverKind::Reference(_, _, Some(_)) => {
                        contract.effects.push("mutates self".into())
                    }
                    syn::ReceiverKind::Value => contract.effects.push("consumes self".into()),
                    _ => {}
                },
                syn::FnArg::Typed(t) => {
                    let name = text(self.source, t.pat.span());
                    if let syn::Type::Reference(r) = &*t.ty
                        && r.mutability.is_some()
                    {
                        contract.effects.push(format!("mutates {name}"));
                    }
                    let description = described
                        .iter()
                        .find(|(n, _)| *n == name)
                        .and_then(|(_, d)| d.clone());
                    contract.inputs.push(Param {
                        ty: Some(text(self.source, t.ty.span())),
                        name,
                        description,
                    });
                }
            }
        }
        if sig.asyncness.is_some() {
            contract.effects.push("async".into());
        }
        if matches!(sig.safety, syn::Safety::Unsafe(_)) {
            contract.effects.push("unsafe".into());
        }
        if let syn::ReturnType::Type(_, ty) = &sig.output {
            contract.outputs.push(Output {
                ty: Some(text(self.source, ty.span())),
                description: doc.section(&["Returns"]).first().cloned(),
            });
            if let Some(error) = result_error(ty, self.source) {
                let described = doc.section(&["Errors"]);
                let failures = if described.is_empty() {
                    vec![None]
                } else {
                    described.into_iter().map(Some).collect()
                };
                let returned = failures.into_iter().map(|description| Failure {
                    kind: FailureKind::Error,
                    ty: error.clone(),
                    description,
                });
                contract.errors.splice(0..0, returned);
            }
        }
        self.out.push((
            sig.ident.span().byte_range().start,
            sig.ident.to_string(),
            contract,
        ));
    }
}

impl<'ast> Visit<'ast> for RustFacts<'_> {
    fn visit_item_fn(&mut self, f: &'ast syn::ItemFn) {
        self.function(&f.attrs, &f.sig);
        visit::visit_item_fn(self, f);
    }
    fn visit_impl_item_fn(&mut self, f: &'ast syn::ImplItemFn) {
        self.function(&f.attrs, &f.sig);
        visit::visit_impl_item_fn(self, f);
    }
    fn visit_trait_item_fn(&mut self, f: &'ast syn::TraitItemFn) {
        self.function(&f.attrs, &f.sig);
        visit::visit_trait_item_fn(self, f);
    }
    fn visit_item_struct(&mut self, s: &'ast syn::ItemStruct) {
        let (mut contract, _) = self.base(&s.attrs);
        for field in &s.fields {
            if let Some(name) = &field.ident {
                contract.inputs.push(Param {
                    name: name.to_string(),
                    ty: Some(text(self.source, field.ty.span())),
                    description: rustdoc(&doc_text(&field.attrs)).summary,
                });
            }
        }
        self.out.push((
            s.ident.span().byte_range().start,
            s.ident.to_string(),
            contract,
        ));
        visit::visit_item_struct(self, s);
    }
    fn visit_item_enum(&mut self, e: &'ast syn::ItemEnum) {
        self.item(&e.attrs, &e.ident);
        visit::visit_item_enum(self, e);
    }
    fn visit_item_trait(&mut self, t: &'ast syn::ItemTrait) {
        self.item(&t.attrs, &t.ident);
        visit::visit_item_trait(self, t);
    }
    fn visit_item_const(&mut self, c: &'ast syn::ItemConst) {
        self.item(&c.attrs, &c.ident);
        visit::visit_item_const(self, c);
    }
    fn visit_item_static(&mut self, s: &'ast syn::ItemStatic) {
        self.item(&s.attrs, &s.ident);
        visit::visit_item_static(self, s);
    }
    fn visit_item_type(&mut self, t: &'ast syn::ItemType) {
        self.item(&t.attrs, &t.ident);
        visit::visit_item_type(self, t);
    }
    fn visit_item_mod(&mut self, m: &'ast syn::ItemMod) {
        self.item(&m.attrs, &m.ident);
        visit::visit_item_mod(self, m);
    }
}

const RUST_KEYWORDS: [&str; 39] = [
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
    "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
    "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type",
    "unsafe", "use", "where", "while", "doc",
];

fn idents(stream: TokenStream, out: &mut Vec<Token>) {
    for tree in stream {
        match tree {
            TokenTree::Ident(i) => {
                let name = i.to_string();
                if let Some(raw) = name.strip_prefix("r#") {
                    out.push((i.span().byte_range().start, raw.to_owned()));
                } else if !RUST_KEYWORDS.contains(&name.as_str()) {
                    out.push((i.span().byte_range().start, name));
                }
            }
            TokenTree::Group(g) => idents(g.stream(), out),
            _ => {}
        }
    }
}

pub fn rust_facts(source: &str) -> std::result::Result<(Vec<Derived>, Vec<Token>), String> {
    let result = syn::parse_file(source)
        .map_err(|e| e.to_string())
        .and_then(|file| {
            let mut facts = RustFacts {
                source,
                out: Vec::new(),
            };
            facts.visit_file(&file);
            let mut tokens = Vec::new();
            idents(
                TokenStream::from_str(source).map_err(|e| e.to_string())?,
                &mut tokens,
            );
            Ok((facts.out, tokens))
        });
    // Spans stay in a thread-local map until released (see platform_symbols::rust).
    proc_macro2::extra::invalidate_current_thread_spans();
    result
}
