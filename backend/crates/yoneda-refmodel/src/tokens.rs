//! Repository tokens: the owner mints them with scopes (`read`, `write`, `land`) and,
//! optionally, a grant of path prefixes; a revoked or unknown token is UNAUTHORIZED. A
//! token needs `read` to read, `write` to commit, and `land` as well to move a protected
//! branch; every path it reads or writes must lie inside its grant (else FORBIDDEN, the
//! same answer whatever lies there).
use crate::{Outcome, Repo};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Scope {
    Read,
    Write,
    Land,
}

#[derive(Clone, Debug)]
pub struct Token {
    pub scopes: BTreeSet<Scope>,
    /// Path prefixes it may touch (`None`: the whole repository).
    pub grant: Option<Vec<String>>,
    pub revoked: bool,
}

impl Token {
    /// Whether `path` is the grant entry itself or lies under it.
    fn allows(&self, path: &str) -> bool {
        self.grant.as_ref().is_none_or(|entries| {
            entries.iter().any(|entry| {
                let entry = entry.trim_end_matches('/');
                path == entry
                    || path
                        .strip_prefix(entry)
                        .is_some_and(|rest| rest.starts_with('/'))
            })
        })
    }
}

impl Repo {
    pub(crate) fn mint(
        &mut self,
        name: &str,
        scopes: &BTreeSet<Scope>,
        grant: &Option<Vec<String>>,
    ) -> Outcome {
        if self.tokens.contains_key(name) {
            return Outcome::Refused("ALREADY_EXISTS");
        }
        let token = Token {
            scopes: scopes.clone(),
            grant: grant.clone(),
            revoked: false,
        };
        self.tokens.insert(name.to_owned(), token);
        Outcome::Done
    }

    pub(crate) fn revoke(&mut self, name: &str) -> Outcome {
        if let Some(token) = self.tokens.get_mut(name) {
            token.revoked = true;
        }
        Outcome::Done
    }

    /// The live token `name` holding `scope` and allowed `path`, or why not.
    fn token(&self, name: &str, scope: Scope, path: &str) -> Result<&Token, &'static str> {
        let token = self
            .tokens
            .get(name)
            .filter(|t| !t.revoked)
            .ok_or("UNAUTHORIZED")?;
        if !token.scopes.contains(&scope) || !token.allows(path) {
            return Err("FORBIDDEN");
        }
        Ok(token)
    }

    /// `repo_path_history` of `path` on main, as token `name`.
    pub(crate) fn token_read(&self, name: &str, path: &str) -> Outcome {
        match self.token(name, Scope::Read, path) {
            Ok(_) => Outcome::Done,
            Err(code) => Outcome::Refused(code),
        }
    }

    /// A one-file commit on `branch`'s tip as token `name`, landed there: a protected
    /// branch needs `land` too, checked when it lands (so the change is checked first).
    pub(crate) fn token_commit(
        &mut self,
        name: &str,
        branch: &str,
        path: &str,
        content: Option<&str>,
    ) -> Outcome {
        let lands = match self.token(name, Scope::Write, path) {
            Err(code) => return Outcome::Refused(code),
            Ok(token) => !Self::protected(branch) || token.scopes.contains(&Scope::Land),
        };
        if lands {
            return self.commit(branch, path, content, false);
        }
        Outcome::Refused(
            self.change_refusal(branch, path, content)
                .unwrap_or("FORBIDDEN"),
        )
    }
}
