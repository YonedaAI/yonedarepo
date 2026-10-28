//! Organization access on a repository, as the adapter resolved it from each org's
//! authority for one request (`orgs` on `_session` or `_pat`): an org owner acts as the
//! owner of the org's repositories, and a team member holds its team entry's role
//! (`team:<org>/<team>#<id>` in `members`: the team's id, so a later team that reuses a
//! deleted team's name holds none of its grants).
use super::members::Role;
use crate::storage::bad;
use serde_json::Value;
use yoneda_core::Result;

/// The organizations the adapter resolved for an account: per org, its role (`owner` or
/// `member`) and its teams. Absent means none.
pub(super) struct Orgs<'a>(Option<&'a serde_json::Map<String, Value>>);

impl<'a> Orgs<'a> {
    pub(super) fn of(credentials: &'a Value) -> Result<Self> {
        match credentials.get("orgs") {
            None | Some(Value::Null) => Ok(Self(None)),
            Some(Value::Object(orgs)) => Ok(Self(Some(orgs))),
            Some(_) => Err(bad("Corrupt organization access")),
        }
    }
    pub(super) fn owns(&self, workspace: &str) -> bool {
        self.0
            .and_then(|orgs| orgs.get(workspace))
            .is_some_and(|org| org["role"] == "owner")
    }
    /// The highest role `account` holds here: its own row or one of its teams'.
    pub(super) fn role(
        &self,
        account: &str,
        member: impl Fn(&str) -> Result<Option<Role>>,
    ) -> Result<Option<Role>> {
        let mut best = member(account)?;
        for (org, access) in self.0.into_iter().flatten() {
            for team in access["teams"].as_array().into_iter().flatten() {
                let (Some(name), Some(id)) = (team["name"].as_str(), team["id"].as_i64()) else {
                    return Err(bad("Corrupt team"));
                };
                best = best.max(member(&format!("team:{org}/{name}#{id}"))?);
            }
        }
        Ok(best)
    }
}
