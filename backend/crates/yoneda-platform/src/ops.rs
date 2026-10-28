//! Closed sets of command names. An authority deserializes a command's `op` into one of
//! these at its boundary, so dispatch is an exhaustive match and an unknown name is refused
//! once, there. Only the `op` field is read: commands carry large payloads (packs, file
//! contents) that deserializing the whole command as a tagged enum would buffer.

/// An enum of op names: each variant deserializes from (and [`name`](Self::name) returns)
/// exactly its wire name.
macro_rules! op_names {
    ($(#[$meta:meta])* $vis:vis enum $name:ident { $($variant:ident = $op:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
        $vis enum $name {
            $(#[serde(rename = $op)] $variant,)+
        }
        impl $name {
            #[cfg(test)]
            pub(crate) const ALL: &[Self] = &[$(Self::$variant,)+];
            // Not every authority names its ops outside tests.
            #[allow(dead_code)]
            pub(crate) fn name(self) -> &'static str {
                match self {
                    $(Self::$variant => $op,)+
                }
            }
        }
    };
}
pub(crate) use op_names;

/// Every `op: '<name>'` literal in the Worker adapter modules whose source passes `keep`.
#[cfg(test)]
pub(crate) fn worker_op_literals(keep: impl Fn(&str) -> bool) -> Vec<String> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../cloudflare/worker");
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "ts") {
            continue;
        }
        let source = std::fs::read_to_string(&path).unwrap();
        if !keep(&source) {
            continue;
        }
        for rest in source.split("op: '").skip(1) {
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_lowercase() || *c == '_')
                .collect();
            if rest[name.len()..].starts_with('\'') {
                names.push(name);
            }
        }
    }
    names.sort_unstable();
    names.dedup();
    names
}
