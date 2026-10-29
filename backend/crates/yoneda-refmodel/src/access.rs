//! Who may read and write: a private repository exists only for its owner and members (to
//! anyone else it is NOT_FOUND); a public one is read by anyone, while writing still needs
//! a write member or the owner (a caller without credentials is asked to sign in). Only
//! the owner's account changes visibility or membership here.
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
        match self.member(caller) {
            None if self.public && access != Access::Push => Outcome::Done,
            None => self.outsider(caller),
            Some(Some(Role::Read)) if access == Access::Push => Outcome::Refused("FORBIDDEN"),
            Some(_) => Outcome::Done,
        }
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

    /// The owner grants `account` `role`, or removes it (`None`; NOT_FOUND for a non-member).
    pub(crate) fn set_member(&mut self, account: &str, role: Option<Role>) -> Outcome {
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
