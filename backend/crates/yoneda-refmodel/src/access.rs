//! Who may read and write: a private repository exists only for its owner and members (to
//! anyone else it is NOT_FOUND); a public one is read by anyone, while writing still needs
//! a write member or the owner (a caller without credentials is asked to sign in). Only
//! the owner's account changes visibility; the owner and admins manage members.
use crate::{Outcome, Repo};

/// Who calls.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Caller {
    Owner,
    /// No credentials at all.
    Anonymous,
    /// A signed-in account (a member or not).
    Account(String),
}

/// What a caller tries; only `Push` writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Status,
    Refs,
    Log,
    Fetch,
    Push,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Read,
    Write,
    /// Acts as the owner, except on visibility and on admins (granting or changing one).
    Admin,
}

impl Repo {
    fn member(&self, caller: &Caller) -> Option<Option<Role>> {
        match caller {
            Caller::Owner => Some(None),
            Caller::Anonymous => None,
            Caller::Account(name) => self.members.get(name).map(|role| Some(*role)),
        }
    }

    /// An outsider's refusal: the repository is hidden when private; when public, the
    /// caller is asked to sign in, or refused as a non-member.
    fn outsider(&self, caller: &Caller) -> Outcome {
        Outcome::Refused(match (self.public, caller) {
            (false, _) => "NOT_FOUND",
            (true, Caller::Anonymous) => "UNAUTHORIZED",
            (true, _) => "FORBIDDEN",
        })
    }

    pub(crate) fn access(&self, caller: &Caller, access: Access) -> Outcome {
        let allowed = match self.member(caller) {
            None if self.public && access != Access::Push => Outcome::Done,
            None => self.outsider(caller),
            Some(Some(Role::Read)) if access == Access::Push => Outcome::Refused("FORBIDDEN"),
            Some(_) => Outcome::Done,
        };
        // Reading the refs waits for the projector once access is granted.
        let reads_refs = matches!(access, Access::Refs | Access::Log);
        if allowed == Outcome::Done && reads_refs && !self.unprojected.is_empty() {
            return Outcome::Refused("PROJECTION_PENDING");
        }
        allowed
    }

    /// `repo_set_visibility`, the owner's account only.
    pub(crate) fn set_visibility(&mut self, caller: &Caller, public: bool) -> Outcome {
        match self.member(caller) {
            None => self.outsider(caller),
            Some(Some(_)) => Outcome::Refused("FORBIDDEN"),
            Some(None) => {
                self.public = public;
                Outcome::Done
            }
        }
    }

    /// `caller` grants `account` `role`, or removes it (`None`): the owner, or an admin
    /// for read and write members (only the owner grants admin or changes an admin);
    /// removing a non-member is NOT_FOUND.
    pub(crate) fn set_member(
        &mut self,
        caller: &Caller,
        account: &str,
        role: Option<Role>,
    ) -> Outcome {
        match self.member(caller) {
            None => return self.outsider(caller),
            Some(Some(Role::Read | Role::Write)) => return Outcome::Refused("FORBIDDEN"),
            Some(_) => {}
        }
        let owner = *caller == Caller::Owner;
        let admin = |role: Option<&Role>| role == Some(&Role::Admin);
        if !owner && (admin(role.as_ref()) || admin(self.members.get(account))) {
            return Outcome::Refused("FORBIDDEN");
        }
        match role {
            Some(role) => {
                self.members.insert(account.to_owned(), role);
                Outcome::Done
            }
            None if self.members.remove(account).is_some() => Outcome::Done,
            None => Outcome::Refused("NOT_FOUND"),
        }
    }
}
