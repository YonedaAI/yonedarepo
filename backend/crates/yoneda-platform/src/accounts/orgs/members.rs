//! Organization member authorization and command dispatch.
use super::*;

/// Commands of the org's members: any member sees it and may leave; owners manage it.
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: OrgMemberOp, now: i64) -> Result<Value> {
    let org = org(db)?;
    let actor = string(c, "actor")?;
    let role = role_of(db, &actor)?.ok_or_else(|| {
        Error::new(
            "FORBIDDEN",
            format!("You are not a member of the {org} organization"),
        )
    })?;
    let leaving = op == OrgMemberOp::MemberRemove && c["account"] == actor.as_str();
    let reads = matches!(op, OrgMemberOp::Show | OrgMemberOp::HoldShow);
    if !reads && role != "owner" && !leaving {
        return Err(Error::new(
            "FORBIDDEN",
            format!("Only an owner of {org} can do this"),
        ));
    }
    let actor = format!("user:{actor}");
    match op {
        OrgMemberOp::Show => show(db, &org, &role),
        OrgMemberOp::Audit => Ok(json!({ "org": org })),
        OrgMemberOp::Delete => delete(db, c, &org, &actor, now),
        OrgMemberOp::MemberPut => member_put(db, c, &org, &actor, now),
        OrgMemberOp::MemberRemove => member_remove(db, c, &org, &actor, now),
        OrgMemberOp::TeamCreate => super::teams::create(db, c, &actor, now),
        OrgMemberOp::TeamDelete => super::teams::delete(db, c, &actor, now),
        OrgMemberOp::TeamMemberPut => super::teams::member_put(db, c, &actor, now),
        OrgMemberOp::TeamMemberRemove => super::teams::member_remove(db, c, &actor, now),
        OrgMemberOp::HoldShow => super::holds::show(db),
        OrgMemberOp::HoldSet => super::holds::owner_set(db, c, &actor, now),
        OrgMemberOp::HoldRelease => super::holds::owner_release(db, c, &actor, now),
    }
}
