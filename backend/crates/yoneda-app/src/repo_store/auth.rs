//! Who is calling. Workspace sessions are owners with every scope; repository tokens are
//! API principals (agents, CI, scripts) with explicit scopes. The platform never sees
//! *what kind* of client a token belongs to, only its name and scopes.
use super::rows::Settings;
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub const SCOPES: [&str; 5] = ["read", "write", "check", "review", "land"];

pub struct Actor {
    pub principal: String,
    pub owner: bool,
    scopes: Vec<String>,
}

impl Actor {
    pub fn require(&self, scope: &str) -> Result<()> {
        if self.owner || self.scopes.iter().any(|s| s == scope) {
            Ok(())
        } else {
            Err(Error::new(
                "FORBIDDEN",
                format!("Token lacks the {scope} scope"),
            ))
        }
    }
    /// Whether this actor holds `scope` itself (owners hold every token scope, not roles).
    pub fn can(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
    pub fn require_any(&self, scopes: &[&str]) -> Result<()> {
        if scopes.iter().any(|s| self.require(s).is_ok()) {
            Ok(())
        } else {
            Err(Error::new(
                "FORBIDDEN",
                format!("Token needs one of the {} scopes", scopes.join("/")),
            ))
        }
    }
    pub fn require_owner(&self) -> Result<()> {
        if self.owner {
            Ok(())
        } else {
            Err(Error::new(
                "FORBIDDEN",
                "Only the repository owner can do this",
            ))
        }
    }
}

fn token_digest(secret: &str) -> String {
    yoneda_core::digest(format!("yonedarepo:repo-token:v1:{secret}").as_bytes())
}

/// `_session`, `_token` and `_system` are set by the authenticating adapter, never by
/// callers. `_system` names a platform role (check executor, ref projector, importer,
/// merger), each holding only the scope its job needs.
pub fn actor<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Actor> {
    if let Some(system @ ("checks" | "projection" | "import" | "merge")) =
        c.get("_system").and_then(Value::as_str)
    {
        let role = match system {
            "import" => "import",
            "merge" => "write",
            _ => "system",
        };
        return Ok(Actor {
            principal: format!("platform:{system}"),
            owner: false,
            scopes: vec!["read".into(), role.into()],
        });
    }
    if let Some(session) = c.get("_session").filter(|s| s.is_object()) {
        if string(session, "workspace")? != settings.workspace {
            return Err(Error::new(
                "FORBIDDEN",
                "Repository belongs to another workspace",
            ));
        }
        return Ok(Actor {
            principal: string(session, "principal")?,
            owner: true,
            scopes: Vec::new(),
        });
    }
    let secret =
        string(c, "_token").map_err(|_| Error::new("UNAUTHORIZED", "Missing credentials"))?;
    let row = db
        .query(
            "SELECT name,scopes FROM tokens WHERE digest=? AND revoked_at IS NULL",
            &[json!(token_digest(&secret))],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("UNAUTHORIZED", "Unknown or revoked token"))?;
    Ok(Actor {
        principal: format!("token:{}", row["name"].as_str().unwrap_or_default()),
        owner: false,
        scopes: serde_json::from_str(row["scopes"].as_str().unwrap_or("[]"))
            .map_err(|_| bad("Corrupt scopes"))?,
    })
}

pub fn create_token<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    actor.require_owner()?;
    let name = string(c, "name")?;
    super::rows::check_name(&name)?;
    let secret = string(c, "_secret")?;
    if secret.len() < 32 {
        return Err(bad("Token secret is too short"));
    }
    let scopes: Vec<String> =
        serde_json::from_value(c["scopes"].clone()).map_err(|_| bad("scopes must be a list"))?;
    if scopes.is_empty() || scopes.iter().any(|s| !SCOPES.contains(&s.as_str())) {
        return Err(bad(
            "Scopes must be some of read, write, check, review, land",
        ));
    }
    if !db
        .query("SELECT name FROM tokens WHERE name=?", &[json!(name)])?
        .is_empty()
    {
        return Err(Error::new(
            "ALREADY_EXISTS",
            "A token with this name exists",
        ));
    }
    db.query(
        "INSERT INTO tokens(name,digest,scopes,created_by,created_at) VALUES(?,?,?,?,?)",
        &[
            json!(name),
            json!(token_digest(&secret)),
            json!(json!(scopes).to_string()),
            json!(actor.principal),
            json!(number(c, "now")?),
        ],
    )?;
    Ok(json!({ "name": name, "principal": format!("token:{name}"), "scopes": scopes }))
}

pub fn revoke_token<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    actor.require_owner()?;
    let name = string(c, "name")?;
    db.query(
        "UPDATE tokens SET revoked_at=? WHERE name=? AND revoked_at IS NULL",
        &[json!(number(c, "now")?), json!(name)],
    )?;
    Ok(json!({ "name": name, "revoked": true }))
}

pub fn list_tokens<S: SqlStore>(db: &S, actor: &Actor) -> Result<Value> {
    actor.require_owner()?;
    Ok(
        json!({ "tokens": db.query("SELECT name,scopes,created_by,created_at,revoked_at FROM tokens ORDER BY name", &[])? }),
    )
}
