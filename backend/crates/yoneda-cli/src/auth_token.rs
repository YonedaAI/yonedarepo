//! `yoneda auth token`: prints the credential the CLI sends (`YONEDA_TOKEN` when set, else
//! the token `yoneda login` stored for the platform) so a script or an agent can use it:
//! `export YONEDA_TOKEN=$(yoneda auth token)`. The token goes to stdout alone, never to
//! stderr or a log, and nothing contacts the platform.
//!
//! A token printed to a terminal stays in its scrollback and in screen shares, so it is
//! printed only into a pipe or a file unless `--show` says the terminal is meant. There is
//! no `--json` form: the bare line is what a pipe wants, and a JSON document would be one
//! more place for the secret.
use crate::error::{Error, Result};
use crate::{output, target};
use std::io::{IsTerminal, Write};

/// Why the token is not printed, or `None` when it may be.
pub fn refusal(json: bool, terminal: bool, show: bool) -> Option<&'static str> {
    if json {
        return Some("auth token has no --json form: it prints the bare token for a pipe");
    }
    (terminal && !show).then_some(
        "refusing to print a token to the terminal; pipe it (export YONEDA_TOKEN=$(yoneda auth token)) or pass --show",
    )
}

pub fn print(origin: Option<&str>, show: bool) -> Result<()> {
    let mut stdout = std::io::stdout();
    if let Some(why) = refusal(output::json(), stdout.is_terminal(), show) {
        return Err(Error::usage(why));
    }
    let origin = target::account_origin(origin)?;
    let token = target::token_for(&origin)?;
    writeln!(stdout, "{}", token.secret())
        .and_then(|()| stdout.flush())
        .map_err(|e| Error::new(format!("writing the token: {e}")))
}

#[cfg(test)]
mod tests {
    use super::refusal;

    #[test]
    fn prints_into_a_pipe_and_to_a_terminal_only_when_asked() {
        assert_eq!(refusal(false, false, false), None);
        assert_eq!(refusal(false, false, true), None);
        assert_eq!(refusal(false, true, true), None);
        assert!(refusal(false, true, false).is_some_and(|w| w.contains("--show")));
        assert!(refusal(true, false, true).is_some_and(|w| w.contains("--json")));
    }
}
