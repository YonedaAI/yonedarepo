//! The MCP tool schemas (`platform_tools.json`) list the same choices the authority
//! accepts: a value the schema leaves out is one an MCP client is never offered, and one
//! it adds is refused here.
use crate::repo_store::{hooks::EVENTS, members::Role};
use serde_json::Value;

fn tool_enum(tool: &str, pointer: &str) -> Vec<String> {
    let tools: Vec<Value> = serde_json::from_str(yoneda_core::PLATFORM_MCP_TOOLS).unwrap();
    let schema = tools
        .iter()
        .find(|t| t["name"] == tool)
        .unwrap_or_else(|| panic!("no tool {tool}"));
    let found = schema["inputSchema"]
        .pointer(pointer)
        .unwrap_or_else(|| panic!("{tool} has no enum at {pointer}"));
    found
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn hook_events_match_the_authority() {
    assert_eq!(
        tool_enum("git_hook_create", "/properties/events/items/enum"),
        EVENTS.to_vec()
    );
}

#[test]
fn member_roles_match_the_authority() {
    let roles = tool_enum("git_member_add", "/properties/role/enum");
    // A new role fails to compile here until it is listed.
    let _every = |r: Role| match r {
        Role::Read | Role::Write | Role::Land | Role::Admin => (),
    };
    let all = [Role::Read, Role::Write, Role::Land, Role::Admin];
    assert_eq!(roles, all.map(|r| r.as_str()).to_vec());
    for role in &roles {
        assert!(Role::parse(role).is_ok(), "{role} is refused");
    }
}
