//! TypeScript and JavaScript facts (see `platform_facts`): contracts from parameter and
//! return annotations plus JSDoc (`@param`, `@returns`, `@throws`, `@invariant`,
//! `@effect`), and identifier tokens from the oxc lexer.
use crate::platform_contracts::{
    Contract, Failure, FailureKind, Output, Param, braced_type, jsdoc, named,
};
use crate::platform_facts::{Derived, Token};
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ClassElement, Comment, Declaration, ExportDefaultDeclarationKind, Expression, FormalParameters,
    Statement, TSTypeAnnotation,
};
use oxc_parser::{Kind, Parser, config::TokensParserConfig};
use oxc_span::{GetSpan, SourceType, Span};

struct Walker<'s, 'a> {
    source: &'s str,
    comments: &'a [Comment],
    out: Vec<Derived>,
}

fn slice(source: &str, span: Span) -> String {
    source
        .get(span.start as usize..span.end as usize)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn annotation(
    source: &str,
    a: &Option<oxc_allocator::Box<'_, TSTypeAnnotation<'_>>>,
) -> Option<String> {
    a.as_ref().map(|t| slice(source, t.type_annotation.span()))
}

impl Walker<'_, '_> {
    /// The JSDoc block directly above `start` (only whitespace between them).
    fn doc_before(&self, start: u32) -> crate::platform_contracts::Doc {
        let comment = self
            .comments
            .iter()
            .rev()
            .find(|c| c.span.end <= start)
            .filter(|c| {
                self.source
                    .get(c.span.end as usize..start as usize)
                    .is_some_and(|gap| gap.trim().is_empty())
            })
            .map(|c| slice_raw(self.source, c.span))
            .filter(|text| text.starts_with("/**"));
        comment.map(|text| jsdoc(&text)).unwrap_or_default()
    }

    fn documented(&self, start: u32) -> (Contract, crate::platform_contracts::Doc) {
        let doc = self.doc_before(start);
        let contract = Contract {
            summary: doc.summary.clone(),
            effects: doc.section(&["effect", "effects", "sideeffect", "sideEffect"]),
            invariants: doc.section(&["invariant"]),
            errors: doc
                .section(&["throws", "throw", "exception"])
                .iter()
                .map(|t| {
                    let (ty, rest) = braced_type(t);
                    Failure {
                        kind: FailureKind::Throw,
                        ty,
                        description: (!rest.is_empty()).then(|| rest.to_owned()),
                    }
                })
                .collect(),
            ..Contract::default()
        };
        (contract, doc)
    }

    fn item(&mut self, start: u32, name_at: u32, name: &str) {
        let (contract, _) = self.documented(start);
        self.out.push((name_at as usize, name.to_owned(), contract));
    }

    #[allow(clippy::too_many_arguments)]
    fn function(
        &mut self,
        start: u32,
        name_at: u32,
        name: &str,
        params: &FormalParameters,
        returns: &Option<oxc_allocator::Box<'_, TSTypeAnnotation<'_>>>,
        is_async: bool,
        generator: bool,
    ) {
        let (mut contract, doc) = self.documented(start);
        let described: Vec<(Option<String>, String, Option<String>)> = doc
            .section(&["param", "arg", "argument"])
            .iter()
            .map(|t| {
                let (ty, rest) = braced_type(t);
                let (name, description) = named(rest);
                (ty, name, description)
            })
            .collect();
        let mut push = |name: String, ty: Option<String>| {
            let doc = described.iter().find(|(_, n, _)| *n == name);
            contract.inputs.push(Param {
                ty: ty.or_else(|| doc.and_then(|d| d.0.clone())),
                description: doc.and_then(|d| d.2.clone()),
                name,
            });
        };
        for p in &params.items {
            push(
                slice(self.source, p.pattern.span()),
                annotation(self.source, &p.type_annotation),
            );
        }
        if let Some(rest) = &params.rest {
            let name = format!("...{}", slice(self.source, rest.rest.argument.span()));
            push(name, annotation(self.source, &rest.type_annotation));
        }
        let returned = doc.section(&["returns", "return"]);
        let (doc_ty, doc_rest) = returned.first().map_or((None, ""), |t| braced_type(t));
        let ty = annotation(self.source, returns).or(doc_ty);
        if ty.is_some() || !doc_rest.is_empty() {
            contract.outputs.push(Output {
                ty,
                description: (!doc_rest.is_empty()).then(|| doc_rest.to_owned()),
            });
        }
        if is_async {
            contract.effects.push("async".into());
        }
        if generator {
            contract.effects.push("generator".into());
        }
        self.out.push((name_at as usize, name.to_owned(), contract));
    }

    fn declaration(&mut self, decl: &Declaration, outer: Option<Span>) {
        let start = |inner: Span| outer.unwrap_or(inner).start;
        match decl {
            Declaration::FunctionDeclaration(f) => {
                if let Some(id) = &f.id {
                    let s = start(f.span);
                    self.function(
                        s,
                        id.span.start,
                        &id.name,
                        &f.params,
                        &f.return_type,
                        f.r#async,
                        f.generator,
                    );
                }
            }
            Declaration::ClassDeclaration(c) => {
                let Some(id) = &c.id else { return };
                self.item(start(c.span), id.span.start, &id.name);
                for element in &c.body.body {
                    if let ClassElement::MethodDefinition(m) = element
                        && let Some(name) = m.key.static_name().and_then(|name| name.into_cow_str())
                    {
                        let f = &m.value;
                        self.function(
                            m.span.start,
                            m.key.span().start,
                            &name,
                            &f.params,
                            &f.return_type,
                            f.r#async,
                            f.generator,
                        );
                    }
                }
            }
            Declaration::VariableDeclaration(v) => {
                for d in &v.declarations {
                    let Some(name) = d.id.get_identifier_name() else {
                        continue;
                    };
                    let s = start(v.span);
                    match &d.init {
                        Some(Expression::ArrowFunctionExpression(a)) => self.function(
                            s,
                            d.id.span().start,
                            &name,
                            &a.params,
                            &a.return_type,
                            a.r#async,
                            false,
                        ),
                        Some(Expression::FunctionExpression(f)) => self.function(
                            s,
                            d.id.span().start,
                            &name,
                            &f.params,
                            &f.return_type,
                            f.r#async,
                            f.generator,
                        ),
                        _ => self.item(s, d.id.span().start, &name),
                    }
                }
            }
            Declaration::TSInterfaceDeclaration(i) => {
                self.item(start(i.span), i.id.span.start, &i.id.name)
            }
            Declaration::TSTypeAliasDeclaration(t) => {
                self.item(start(t.span), t.id.span.start, &t.id.name)
            }
            Declaration::TSEnumDeclaration(t) => {
                self.item(start(t.span), t.id.span.start, &t.id.name)
            }
            _ => {}
        }
    }
}

fn slice_raw(source: &str, span: Span) -> String {
    source
        .get(span.start as usize..span.end as usize)
        .unwrap_or_default()
        .to_owned()
}

pub fn facts(path: &str, source: &str) -> Result<(Vec<Derived>, Vec<Token>), String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|e| format!("{e:?}"))?;
    let parsed = Parser::new(&allocator, source, source_type)
        .with_config(TokensParserConfig)
        .parse();
    if parsed.fatal_error || parsed.diagnostics.has_errors() {
        return Err("Syntax error".into());
    }
    let mut walker = Walker {
        source,
        comments: &parsed.program.comments,
        out: Vec::new(),
    };
    for statement in &parsed.program.body {
        match statement {
            Statement::ExportDeclaration(export) => {
                walker.declaration(&export.declaration, Some(export.span));
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                    let (name, at) =
                        f.id.as_ref()
                            .map_or(("default".into(), export.span.start), |id| {
                                (id.name.as_str().to_owned(), id.span.start)
                            });
                    walker.function(
                        export.span.start,
                        at,
                        &name,
                        &f.params,
                        &f.return_type,
                        f.r#async,
                        f.generator,
                    );
                }
                ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                    let (name, at) =
                        c.id.as_ref()
                            .map_or(("default".into(), export.span.start), |id| {
                                (id.name.as_str().to_owned(), id.span.start)
                            });
                    walker.item(export.span.start, at, &name);
                }
                _ => {}
            },
            other => {
                if let Some(decl) = other.as_declaration() {
                    walker.declaration(decl, None);
                }
            }
        }
    }
    let tokens = parsed
        .tokens
        .iter()
        .filter(|t| t.kind() == Kind::Ident)
        .map(|t| {
            let (start, end) = (t.start() as usize, t.end() as usize);
            (start, source.get(start..end).unwrap_or_default().to_owned())
        })
        .collect();
    Ok((walker.out, tokens))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typescript_contracts_come_from_annotations_and_jsdoc() {
        let source = "import { fetchUser } from './api';\n\n/**\n * Loads a user.\n * @param id - the user id\n * @returns the user record\n * @throws {NotFound} when the id is unknown\n * @invariant never caches failures\n */\nexport async function load(id: string, ...rest: number[]): Promise<User> {\n  return fetchUser(id);\n}\n\nexport const twice = (n: number): number => n * 2;\n";
        let (derived, tokens) = facts("src/load.ts", source).unwrap();
        let load = &derived.iter().find(|d| d.1 == "load").unwrap().2;
        assert_eq!(load.summary.as_deref(), Some("Loads a user."));
        assert_eq!(load.inputs[0].description.as_deref(), Some("the user id"));
        assert_eq!(load.inputs[0].ty.as_deref(), Some("string"));
        assert_eq!(load.inputs[1].name, "...rest");
        assert_eq!(load.outputs[0].ty.as_deref(), Some("Promise<User>"));
        assert_eq!(
            load.outputs[0].description.as_deref(),
            Some("the user record")
        );
        assert_eq!(load.errors[0].ty.as_deref(), Some("NotFound"));
        assert_eq!(load.effects, ["async"]);
        assert_eq!(load.invariants, ["never caches failures"]);
        let twice = &derived.iter().find(|d| d.1 == "twice").unwrap().2;
        assert_eq!(twice.inputs[0].ty.as_deref(), Some("number"));
        assert!(tokens.iter().any(|(_, t)| t == "fetchUser"));
        assert!(!tokens.iter().any(|(_, t)| t == "function" || t == "return"));
    }
}
