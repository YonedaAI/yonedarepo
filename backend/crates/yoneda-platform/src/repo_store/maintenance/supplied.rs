//! The archived log objects one command carries (`_archive`: object key → text, or null
//! when the store had no such object). They are scoped to that command's transaction, so
//! any check deep in a landing can verify and use them without every caller threading the
//! command through; nothing outlives the command, and a nested scope restores the outer.
use serde_json::{Map, Value};
use std::cell::RefCell;
use yoneda_core::{Error, Result};

thread_local! {
    static SUPPLIED: RefCell<Map<String, Value>> = RefCell::default();
}

/// Restores the enclosing command's objects when the scope ends, also on unwinding.
struct Scope(Map<String, Value>);
impl Drop for Scope {
    fn drop(&mut self) {
        SUPPLIED.set(std::mem::take(&mut self.0));
    }
}

/// Runs `run` with the objects `command` carries.
pub fn scoped<T>(command: &Value, run: impl FnOnce() -> T) -> T {
    let objects = command
        .get("_archive")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let _restore = Scope(SUPPLIED.replace(objects));
    run()
}

/// Whether the command carried `key` (even as null: a missing object is then refused).
pub(super) fn has(key: &str) -> bool {
    SUPPLIED.with_borrow(|objects| objects.contains_key(key))
}

/// Parses the carried text of `key` with `open`, which verifies its fingerprint.
pub(super) fn open<T>(key: &str, open: impl FnOnce(&str) -> Result<T>) -> Result<T> {
    SUPPLIED.with_borrow(|objects| match objects.get(key).and_then(Value::as_str) {
        Some(text) => open(text),
        None => Err(Error::new(
            "ARCHIVE_CORRUPT",
            format!("Archived {key} is missing from the object store"),
        )),
    })
}
