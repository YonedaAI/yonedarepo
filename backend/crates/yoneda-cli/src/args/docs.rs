//! The agent skills and the CLI guide name only commands and flags the parser accepts:
//! every `yoneda …` command in their code (fenced blocks and inline code) is parsed, with
//! placeholders filled in, so the documents cannot drift from `yoneda --help`.
use super::*;

const SKILL: &str = include_str!("../../../../../plugins/yoneda/skills/yoneda/SKILL.md");
const CODEX_SKILL: &str = include_str!("../../../../../plugins/codex/skills/yoneda/SKILL.md");
const GEMINI: &str = include_str!("../../../../../plugins/gemini/GEMINI.md");
const CODEX_AGENTS: &str = include_str!("../../../../../plugins/codex/AGENTS.md");
const GUIDE: &str = include_str!("../../../../../docs/remote-mcp.md");

/// The `yoneda …` commands in a Markdown document's code.
fn commands(doc: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut fenced = false;
    for line in doc.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        let spans: Vec<&str> = if fenced {
            vec![line.split(" #").next().unwrap_or_default()]
        } else {
            line.split('`').skip(1).step_by(2).collect()
        };
        found.extend(
            spans
                .into_iter()
                .map(str::trim)
                .filter(|s| s.starts_with("yoneda "))
                .map(str::to_owned),
        );
    }
    found
}

/// The argument lists a documented command stands for: optional parts included,
/// placeholders filled in, and each `a|b` alternative on its own.
fn concrete(command: &str) -> Vec<Vec<String>> {
    let mut lines = vec![Vec::new()];
    for word in command.replace(['[', ']'], "").split_whitespace().skip(1) {
        let word = match word {
            "<version>" | "<n>" => "7".to_owned(),
            w if w.starts_with('<') && w.ends_with('>') => "x".to_owned(),
            w => w.to_owned(),
        };
        let choices: Vec<String> = word.split('|').map(str::to_owned).collect();
        lines = lines
            .into_iter()
            .flat_map(|line| {
                choices.iter().map(move |c| {
                    let mut next = line.clone();
                    next.push(c.clone());
                    next
                })
            })
            .collect();
    }
    lines
}

#[test]
fn every_documented_command_parses() {
    let docs = [
        ("plugins/yoneda/skills/yoneda/SKILL.md", SKILL),
        ("plugins/gemini/GEMINI.md", GEMINI),
        ("plugins/codex/AGENTS.md", CODEX_AGENTS),
        ("docs/remote-mcp.md", GUIDE),
    ];
    for (name, doc) in docs {
        let found = commands(doc);
        assert!(!found.is_empty(), "{name} names no commands");
        for command in found {
            for args in concrete(&command) {
                let parsed = parse(&args);
                assert!(
                    parsed
                        .as_ref()
                        .is_ok_and(|c| *c != Command::Help || args == ["help"]),
                    "{name}: `{command}` ({args:?}) does not parse: {:?}",
                    parsed.err().map(|e| e.message)
                );
            }
        }
    }
}

#[test]
fn the_skill_covers_the_read_commands_and_their_time_travel() {
    let found = commands(SKILL).join("\n");
    for read in ["grep", "symbols", "blame", "log", "diff"] {
        assert!(found.contains(&format!("yoneda {read}")), "{read}");
    }
    // The skill says every read takes --at <version>: each does.
    for line in [
        "log --at 7",
        "log a.txt --at 7",
        "grep x --at 7",
        "blame a.txt --at 7",
        "diff a b --at 7",
        "symbols a.rs --at 7",
    ] {
        let args: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
        assert!(parse(&args).is_ok(), "{line}");
    }
}

#[test]
fn every_agent_gets_the_same_skill() {
    assert_eq!(CODEX_SKILL, SKILL);
    let body = SKILL
        .splitn(3, "---\n")
        .nth(2)
        .map(str::trim_start)
        .unwrap_or_default();
    assert_eq!(GEMINI, body);
}

#[test]
fn reads_commands_from_code_only() {
    let doc = "Run `yoneda log [path]` or `git push`.\n```sh\nyoneda grep <query> -i   # hits\ngit status\n```\nyoneda prose\n";
    assert_eq!(
        commands(doc),
        ["yoneda log [path]", "yoneda grep <query> -i"]
    );
    assert_eq!(
        concrete("yoneda review approve|reject <sha> [--at <version>]"),
        [
            ["review", "approve", "x", "--at", "7"],
            ["review", "reject", "x", "--at", "7"]
        ]
    );
}
