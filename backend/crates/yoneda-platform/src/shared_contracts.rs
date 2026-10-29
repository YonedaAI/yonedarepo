//! Contracts the TypeScript side shares, as JSON Schemas derived from the Rust types that
//! produce them. `cargo xtask contracts` writes each as `shared/contracts/<name>.ts` (its
//! types and the schema itself); a test there fails while a committed file is stale.
use crate::repo_store::{change_gates::ChangeGates, policy::Policy, status::RepoStatus};
use serde_json::{Value, json};
use yoneda_core::account::{ACCOUNT_IDENTIFIER_HELP, MAX_ACCOUNT_IDENTIFIER_BYTES};

/// Every shared contract: (file name, JSON Schema). A root schema's `title` names its type.
pub fn schemas() -> Vec<(&'static str, Value)> {
    vec![
        ("account", account_identifier()),
        ("repo-status", response::<RepoStatus>()),
        ("policy", request::<Policy>()),
        ("change-gates", response::<ChangeGates>()),
    ]
}

/// The schema of `T` as it deserializes: what a client may send (defaulted fields optional).
fn request<T: schemars::JsonSchema>() -> Value {
    schemars::generate::SchemaSettings::draft2020_12()
        .for_deserialize()
        .into_generator()
        .into_root_schema_for::<T>()
        .to_value()
}

/// The schema of `T` as it serializes: an `Option` field is always present (maybe null),
/// a `#[serde(default)]` one is not optional, only `skip_serializing_if` fields are.
fn response<T: schemars::JsonSchema>() -> Value {
    schemars::generate::SchemaSettings::draft2020_12()
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<T>()
        .to_value()
}

/// An account identifier as the browser may send it; `yoneda_core::account` (mirrored by
/// `shared/account.ts`) decides validity and the canonical form.
fn account_identifier() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "AccountIdentifier",
        "description": ACCOUNT_IDENTIFIER_HELP,
        "type": "string",
        "maxLength": MAX_ACCOUNT_IDENTIFIER_BYTES,
    })
}
