//! `yoneda completion bash|zsh|fish|powershell`: a script completing commands and their
//! subcommands. The installers run it from the person's shell start, so what a shell offers
//! is always what this binary parses.
use crate::command::Shell;

/// Every command a person types, with its subcommands (`hook` is for agents' plugins).
const COMMANDS: &[(&str, &[&str])] = &[
    ("auth", &["token"]),
    ("blame", &[]),
    (
        "change",
        &[
            "close", "comment", "create", "delete", "land", "list", "reopen", "route", "show",
        ],
    ),
    ("check", &["run", "status"]),
    ("clone", &[]),
    ("completion", &["bash", "fish", "powershell", "zsh"]),
    ("conflicts", &[]),
    ("context", &[]),
    ("diff", &[]),
    ("flight-plan", &[]),
    ("grep", &[]),
    ("help", &[]),
    ("land", &[]),
    ("local", &["init", "serve", "status"]),
    ("log", &[]),
    ("login", &[]),
    ("logout", &[]),
    ("memory", &["add", "list", "retire", "show"]),
    (
        "org",
        &[
            "create", "delete", "list", "member", "repos", "show", "team",
        ],
    ),
    ("policy", &["set", "show"]),
    ("pull", &[]),
    ("push", &[]),
    ("reads", &["add", "clear", "list"]),
    ("rebase", &[]),
    ("release", &["create", "list", "show"]),
    (
        "repo",
        &[
            "create",
            "delete",
            "fork",
            "import",
            "list",
            "remote",
            "visibility",
        ],
    ),
    ("review", &["approve", "reject"]),
    ("search", &[]),
    ("session", &["list", "record"]),
    ("setup", &["claude", "codex", "gemini", "opencode"]),
    ("sparse", &[]),
    ("ssh", &["setup"]),
    ("ssh-key", &["add", "list", "rm"]),
    ("status", &[]),
    ("symbols", &[]),
    ("sync", &[]),
    ("token", &["create", "list", "revoke"]),
    ("version", &[]),
];

const BASH: &str = r#"_yoneda() {
  local current=${COMP_WORDS[COMP_CWORD]}
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "@COMMANDS@" -- "$current"))
  elif [ "$COMP_CWORD" -eq 2 ]; then
    case ${COMP_WORDS[1]} in
@CASES@
    esac
  fi
}
complete -o default -F _yoneda yoneda
"#;
const BASH_CASE: &str = r#"      @NAME@) COMPREPLY=($(compgen -W "@WORDS@" -- "$current")) ;;"#;

const ZSH: &str = r#"_yoneda() {
  if (( CURRENT == 2 )); then
    compadd -- @COMMANDS@
  elif (( CURRENT == 3 )); then
    case ${words[2]} in
@CASES@
      *) _files ;;
    esac
  else
    _files
  fi
}
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -i; }
compdef _yoneda yoneda
"#;
const ZSH_CASE: &str = "      @NAME@) compadd -- @WORDS@ ;;";

const FISH: &str = "complete -c yoneda -n __fish_use_subcommand -f -a '@COMMANDS@'\n@CASES@\n";
const FISH_CASE: &str =
    "complete -c yoneda -n '__fish_seen_subcommand_from @NAME@' -f -a '@WORDS@'";

const POWERSHELL: &str = r#"Register-ArgumentCompleter -Native -CommandName yoneda -ScriptBlock {
  param($word, $line, $cursor)
  $parts = @($line.ToString().Substring(0, [Math]::Min($cursor, $line.ToString().Length)) -split '\s+')
  $subcommands = @{
@CASES@
  }
  $choices = if ($parts.Count -le 2) {
    '@COMMANDS@' -split ' '
  } elseif ($parts.Count -eq 3 -and $subcommands.ContainsKey($parts[1])) {
    $subcommands[$parts[1]] -split ' '
  } else {
    @()
  }
  $choices | Where-Object { $_ -like "$word*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_)
  }
}
"#;
const POWERSHELL_CASE: &str = "    '@NAME@' = '@WORDS@'";

/// `template` with its command list and one `case` per command that has subcommands.
fn fill(template: &str, case: &str) -> String {
    let names: Vec<&str> = COMMANDS.iter().map(|(name, _)| *name).collect();
    let cases: Vec<String> = COMMANDS
        .iter()
        .filter(|(_, words)| !words.is_empty())
        .map(|(name, words)| {
            case.replace("@NAME@", name)
                .replace("@WORDS@", &words.join(" "))
        })
        .collect();
    template
        .replace("@COMMANDS@", &names.join(" "))
        .replace("@CASES@", &cases.join("\n"))
}

/// The completion script for `shell`.
pub fn script(shell: Shell) -> String {
    match shell {
        Shell::Bash => fill(BASH, BASH_CASE),
        Shell::Zsh => fill(ZSH, ZSH_CASE),
        Shell::Fish => fill(FISH, FISH_CASE),
        Shell::Powershell => fill(POWERSHELL, POWERSHELL_CASE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The commands `args::parse` matches on, read from its source.
    fn parsed_commands() -> Vec<String> {
        let source = include_str!("args/mod.rs");
        let table = source
            .split("Ok(match command.as_str()")
            .nth(1)
            .and_then(|rest| rest.split("other =>").next())
            .unwrap_or_default();
        table
            .lines()
            .filter(|line| line.contains("=>"))
            .flat_map(|line| {
                line.split("=>")
                    .next()
                    .unwrap_or_default()
                    .split('|')
                    .map(|word| word.trim().trim_matches('"').to_owned())
                    .collect::<Vec<_>>()
            })
            .filter(|word| !word.starts_with('-') && !word.is_empty())
            .collect()
    }

    #[test]
    fn every_command_a_person_types_completes() {
        let found = parsed_commands();
        assert!(found.len() > 30, "{found:?}");
        for command in found.iter().filter(|c| *c != "hook") {
            assert!(
                COMMANDS.iter().any(|(name, _)| name == command),
                "{command} does not complete"
            );
        }
        for (name, _) in COMMANDS {
            assert!(found.iter().any(|c| c == name), "{name} is not a command");
        }
    }

    #[test]
    fn every_subcommand_is_one_the_parser_knows() {
        for (name, words) in COMMANDS {
            for word in *words {
                if matches!(*name, "repo" | "org" | "ssh-key" | "completion" | "setup") {
                    continue;
                }
                let args = [name.to_string(), word.to_string()];
                let refused = crate::args::parse(&args)
                    .err()
                    .is_some_and(|e| e.message.starts_with("unknown"));
                assert!(!refused, "{name} {word}");
            }
        }
    }

    #[test]
    fn each_shell_gets_the_commands_and_their_subcommands() {
        for shell in [Shell::Bash, Shell::Zsh, Shell::Fish, Shell::Powershell] {
            let text = script(shell);
            assert!(!text.contains('@') || shell == Shell::Powershell, "{text}");
            assert!(!text.contains("@COMMANDS@") && !text.contains("@CASES@"));
            assert!(text.contains("flight-plan"), "{shell:?}");
            assert!(text.contains("close comment create"), "{shell:?}");
        }
    }
}
