//! Smart-HTTP receive-pack framing for server-side pushes of freshly built objects.
use crate::Result;
use crate::git_object::{ObjectId, invalid};

/// Recorded commits stay reachable in the object store under a hidden ref, so the store
/// never collects them before (or without) a branch pointing at them.
const HIDDEN_REF_PREFIX: &str = "refs/yoneda/c/";

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

/// Body deleting `refname` (expected at `old`): a delete command and no pack, as Git
/// clients send for `git push --delete`.
pub fn receive_pack_delete(refname: &str, old: ObjectId) -> Result<Vec<u8>> {
    if !refname.starts_with("refs/") || refname.contains(['\0', '\n', ' ']) {
        return Err(invalid("Invalid ref name for delete"));
    }
    let zero = "0".repeat(40);
    let mut body = pkt(&format!(
        "{old} {zero} {refname}\0report-status delete-refs\n"
    ))
    .into_bytes();
    body.extend_from_slice(b"0000");
    Ok(body)
}

/// Accepts only `unpack ok` plus `ok <refname>`, so a partial or rejected push never counts.
pub fn verify_receive_pack_report(bytes: &[u8], refname: &str) -> Result<()> {
    let lines = report_lines(bytes)?;
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

/// A report's pkt-lines, with `None` for each flush packet.
pub(super) fn report_lines(mut bytes: &[u8]) -> Result<Vec<Option<&[u8]>>> {
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
    Ok(lines)
}

/// One ref update parsed from a receive-pack request (server side of `receive_pack_request`).
#[derive(Debug, PartialEq, Eq)]
pub struct ReceivedPush<'a> {
    pub refname: String,
    pub old: Option<ObjectId>,
    pub new: ObjectId,
    pub pack: &'a [u8],
}

/// Parses a single-command receive-pack request as produced by this platform.
pub fn parse_receive_pack_request(bytes: &[u8]) -> Result<ReceivedPush<'_>> {
    let len = bytes
        .get(..4)
        .and_then(|h| std::str::from_utf8(h).ok())
        .and_then(|h| usize::from_str_radix(h, 16).ok())
        .filter(|len| *len > 4)
        .ok_or_else(|| invalid("Malformed receive-pack command"))?;
    let line = bytes
        .get(4..len)
        .ok_or_else(|| invalid("Truncated receive-pack command"))?;
    if bytes.get(len..len + 4) != Some(b"0000") {
        return Err(invalid("Only one ref update per push is supported"));
    }
    let command = line.split(|b| *b == 0).next().unwrap_or_default();
    let text = std::str::from_utf8(command).map_err(|_| invalid("Command is not UTF-8"))?;
    let mut parts = text.trim_end_matches('\n').split(' ');
    let (Some(old), Some(new), Some(refname), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(invalid("Malformed ref update"));
    };
    let zero = "0".repeat(40);
    Ok(ReceivedPush {
        refname: refname.to_owned(),
        old: (old != zero).then(|| ObjectId::parse(old)).transpose()?,
        new: ObjectId::parse(new)?,
        pack: &bytes[len + 4..],
    })
}

/// The report-status a Git server sends: `ok <ref>`, or `ng <ref> <reason>` on refusal.
pub fn receive_pack_report(refname: &str, refused: Option<&str>) -> Vec<u8> {
    let mut out = pkt("unpack ok\n").into_bytes();
    let line = match refused {
        None => format!("ok {refname}\n"),
        Some(reason) => format!("ng {refname} {reason}\n"),
    };
    out.extend_from_slice(pkt(&line).as_bytes());
    out.extend_from_slice(b"0000");
    out
}

/// Classifies a report: `Ok(None)` accepted, `Ok(Some(reason))` the server refused the
/// ref update (for example a stale expected-old value), `Err` anything malformed.
pub fn receive_pack_outcome(bytes: &[u8], refname: &str) -> Result<Option<String>> {
    if verify_receive_pack_report(bytes, refname).is_ok() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(bytes);
    let prefix = format!("ng {refname} ");
    text.split('\n')
        .find_map(|line| line.get(4..).and_then(|l| l.strip_prefix(&prefix)))
        .map(|reason| Some(reason.trim().to_owned()))
        .ok_or_else(|| invalid(format!("Unrecognized push report for {refname}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_report_round_trip() {
        let new = ObjectId::parse(&"a".repeat(40)).unwrap();
        let body = receive_pack_request("refs/yoneda/c/x", None, new, b"PACKDATA").unwrap();
        let push = parse_receive_pack_request(&body).unwrap();
        assert_eq!(
            push,
            ReceivedPush {
                refname: "refs/yoneda/c/x".into(),
                old: None,
                new,
                pack: b"PACKDATA"
            }
        );
        verify_receive_pack_report(
            &receive_pack_report("refs/yoneda/c/x", None),
            "refs/yoneda/c/x",
        )
        .unwrap();
        let refused = receive_pack_report("refs/heads/main", Some("stale info"));
        assert!(verify_receive_pack_report(&refused, "refs/heads/main").is_err());
        assert_eq!(
            receive_pack_outcome(&refused, "refs/heads/main").unwrap(),
            Some("stale info".into())
        );
        let accepted = receive_pack_report("refs/heads/main", None);
        assert_eq!(
            receive_pack_outcome(&accepted, "refs/heads/main").unwrap(),
            None
        );
        assert!(receive_pack_outcome(b"0000", "refs/heads/main").is_err());
        assert!(parse_receive_pack_request(b"0000").is_err());
    }
}
