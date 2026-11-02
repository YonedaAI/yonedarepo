//! `yoneda logout`, or `--agent`: ends one login. The stored token is revoked on the platform,
//! then removed from this machine, leaving any other store alone. A token a person pasted in
//! with `--with-token` stays live: it may be in use elsewhere. The machine forgets the token
//! whatever the platform answers, and says so when the token outlives it.
use crate::api::Api;
use crate::credentials::{self, Token};
use crate::error::Result;
use crate::{human, output};
use std::time::Duration;

/// How long a logout waits for the platform before going ahead without it.
const REVOKE_WAIT: Duration = Duration::from_secs(10);

/// What became of the token on the platform.
enum Ended {
    Revoked,
    HandMade,
    Unreached(String),
}

async fn end(origin: &str, token: &Token) -> Ended {
    let call = async {
        Api::account(origin, Some(token))
            .map_err(|e| e.message)?
            .delete("/device/token")
            .await
            // A token the platform no longer knows is ended already.
            .map_err(|failure| match failure.status {
                401 => String::new(),
                _ => failure.to_string(),
            })
    };
    match tokio::time::timeout(REVOKE_WAIT, call).await {
        Ok(Ok(answer)) if answer["revoked"] == true => Ended::Revoked,
        Ok(Ok(_)) => Ended::HandMade,
        Ok(Err(why)) if why.is_empty() => Ended::Revoked,
        Ok(Err(why)) => Ended::Unreached(why),
        Err(_) => Ended::Unreached("the platform did not answer".to_owned()),
    }
}

/// `yoneda logout`, or `--agent`: removes that one store and leaves any other.
pub async fn logout(origin: Option<&str>, agent: Option<String>) -> Result<()> {
    let path = credentials::path_for(agent.or_else(credentials::env_agent).as_deref())?;
    let ended = match credentials::stored(&path, origin) {
        Some((at, token)) => Some(end(&at, &token).await),
        None => None,
    };
    let removed = credentials::remove(&path, origin)?;
    match &ended {
        None => human!("No stored token to remove"),
        Some(Ended::Revoked) => {
            human!(
                "Removed the stored token ({}) and revoked it",
                path.display()
            )
        }
        Some(Ended::HandMade) => human!(
            "Removed the stored token ({}). It wasn't made by yoneda login, so it stays live: Settings → Personal tokens revokes it",
            path.display()
        ),
        Some(Ended::Unreached(why)) => human!(
            "Removed the stored token ({}). It is still live ({why}): Settings → Signed-in CLIs revokes it",
            path.display()
        ),
    }
    output::emit(&output::Logout {
        removed,
        revoked: matches!(ended, Some(Ended::Revoked)),
        credentials: path.display().to_string(),
    });
    Ok(())
}
