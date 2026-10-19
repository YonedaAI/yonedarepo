//! Smart-HTTP receive-pack framing for server-side pushes of freshly built objects.
use super::{ObjectId, invalid};
use crate::Result;

/// Recorded commits stay reachable in the object store under a hidden ref, so the store
/// never collects them before (or without) a branch pointing at them.
pub const HIDDEN_REF_PREFIX: &str = "refs/yoneda/c/";

pub fn hidden_ref(commit: &ObjectId) -> String {
    format!("{HIDDEN_REF_PREFIX}{commit}")
}

fn pkt(line: &str) -> String {
    format!("{:04x}{line}", line.len() + 4)
}

/// Body for `POST <remote>/git-receive-pack`: one ref update, report-status, then the pack.
pub fn receive_pack_request(
    refname: &str,
    old: Option<ObjectId>,
    new: ObjectId,
    pack: &[u8],
) -> Result<Vec<u8>> {
    if !refname.starts_with("refs/")
        || refname.contains(['\0', '\n', ' ', '\\'])
        || refname.contains("..")
    {
        return Err(invalid("Invalid ref name for push"));
    }
    let old = old.map_or_else(|| "0".repeat(40), |id| id.hex());
    let mut body = pkt(&format!("{old} {new} {refname}\0report-status\n")).into_bytes();
    body.extend_from_slice(b"0000");
    body.extend_from_slice(pack);
    Ok(body)
}

/// Accepts only `unpack ok` plus `ok <refname>`, so a partial or rejected push never counts.
pub fn verify_receive_pack_report(mut bytes: &[u8], refname: &str) -> Result<()> {
    let mut lines = Vec::new();
    while !bytes.is_empty() {
        let len = std::str::from_utf8(bytes.get(..4).ok_or_else(|| invalid("Truncated report"))?)
            .ok()
            .and_then(|hex| usize::from_str_radix(hex, 16).ok())
            .ok_or_else(|| invalid("Malformed report packet"))?;
        if len == 0 {
            lines.push(None);
            bytes = &bytes[4..];
            continue;
        }
        let line = bytes
            .get(4..len)
            .ok_or_else(|| invalid("Truncated report packet"))?;
        lines.push(Some(line));
        bytes = &bytes[len..];
    }
    let expected = format!("ok {refname}\n");
    if lines != [Some(&b"unpack ok\n"[..]), Some(expected.as_bytes()), None] {
        return Err(invalid(format!(
            "Object store did not acknowledge {refname}: {}",
            String::from_utf8_lossy(
                &lines
                    .iter()
                    .flatten()
                    .flat_map(|l| l.iter().copied())
                    .collect::<Vec<_>>()
            )
        )));
    }
    Ok(())
}
