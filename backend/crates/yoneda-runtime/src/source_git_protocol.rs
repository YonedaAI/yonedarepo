//! Git smart HTTP receive-pack framing, scoped to the trusted capture fork's frozen branch ref.
use crate::source_git_tree::validate_oid;
use std::io;

fn packets(mut bytes: &[u8]) -> io::Result<Vec<Option<&[u8]>>> {
    if bytes.len() > 1024 * 1024 {
        return Err(io::Error::other("Git protocol metadata exceeds bound"));
    }
    let mut result = Vec::new();
    while !bytes.is_empty() {
        let header = bytes
            .get(..4)
            .ok_or_else(|| io::Error::other("Truncated Git packet header"))?;
        let length = usize::from_str_radix(
            std::str::from_utf8(header)
                .map_err(|_| io::Error::other("Invalid Git packet header"))?,
            16,
        )
        .map_err(|_| io::Error::other("Invalid Git packet length"))?;
        if length == 0 {
            result.push(None);
            bytes = &bytes[4..];
            continue;
        }
        if !(4..=65520).contains(&length) {
            return Err(io::Error::other("Unsupported Git packet length"));
        }
        result.push(Some(
            bytes
                .get(4..length)
                .ok_or_else(|| io::Error::other("Truncated Git packet"))?,
        ));
        bytes = &bytes[length..];
    }
    Ok(result)
}

pub(crate) fn advertisement_ref(bytes: &[u8], reference: &str) -> io::Result<String> {
    validate_ref(reference)?;
    advertised(bytes, reference, false)
}
pub(crate) fn advertisement_input(bytes: &[u8], reference: &str) -> io::Result<String> {
    validate_input_ref(reference)?;
    advertised(bytes, reference, true)
}
fn advertised(bytes: &[u8], reference: &str, absent: bool) -> io::Result<String> {
    let packets = packets(bytes)?;
    if packets.first() != Some(&Some(b"# service=git-receive-pack\n".as_slice()))
        || packets.get(1) != Some(&None)
        || packets.last() != Some(&None)
        || packets.len() < 4
    {
        return Err(io::Error::other("Invalid smart receive-pack discovery"));
    }
    let first = packets
        .get(2)
        .and_then(|p| *p)
        .ok_or_else(|| io::Error::other("Git fork advertisement empty"))?;
    let separator = first
        .iter()
        .position(|b| *b == 0)
        .ok_or_else(|| io::Error::other("Git capabilities absent"))?;
    let capabilities = &first[separator + 1..];
    let capabilities = std::str::from_utf8(capabilities)
        .map_err(|_| io::Error::other("Invalid Git capabilities"))?;
    let capabilities = capabilities.split_ascii_whitespace().collect::<Vec<_>>();
    if !capabilities.contains(&"report-status")
        || capabilities
            .iter()
            .any(|c| c.starts_with("object-format=") && *c != "object-format=sha1")
    {
        return Err(io::Error::other(
            "Git fork does not support SHA-1 capture status",
        ));
    }
    let mut head = None;
    for packet in &packets[2..packets.len() - 1] {
        let packet = packet.ok_or_else(|| io::Error::other("Unexpected Git discovery flush"))?;
        let line = packet
            .split(|b| *b == 0)
            .next()
            .ok_or_else(|| io::Error::other("Empty Git ref"))?;
        let line = std::str::from_utf8(line)
            .map_err(|_| io::Error::other("Invalid Git ref"))?
            .trim_end_matches('\n');
        let (oid, name) = line
            .split_once(' ')
            .ok_or_else(|| io::Error::other("Invalid Git ref record"))?;
        validate_oid(oid)?;
        if name == reference {
            if head.is_some() || oid.bytes().all(|b| b == b'0') {
                return Err(io::Error::other("Invalid frozen Git fork ref"));
            }
            head = Some(oid.to_owned());
        }
    }
    if absent {
        Ok(head.unwrap_or_else(|| "0".repeat(40)))
    } else {
        head.ok_or_else(|| io::Error::other("Frozen Git fork ref is missing"))
    }
}

pub(crate) fn command_ref(reference: &str, old: &str, new: &str) -> io::Result<Vec<u8>> {
    validate_ref(reference)?;
    command(reference, old, new)
}
pub(crate) fn command_input(reference: &str, new: &str) -> io::Result<Vec<u8>> {
    validate_input_ref(reference)?;
    command(reference, &"0".repeat(40), new)
}
fn command(reference: &str, old: &str, new: &str) -> io::Result<Vec<u8>> {
    validate_oid(old)?;
    validate_oid(new)?;
    let command = format!("{old} {new} {reference}\0report-status\n");
    Ok(format!("{:04x}{command}0000", command.len() + 4).into_bytes())
}

pub(crate) fn successful_ref_report(bytes: &[u8], reference: &str) -> io::Result<()> {
    validate_ref(reference)?;
    report(bytes, reference)
}
pub(crate) fn successful_input_report(bytes: &[u8], reference: &str) -> io::Result<()> {
    validate_input_ref(reference)?;
    report(bytes, reference)
}
fn report(bytes: &[u8], reference: &str) -> io::Result<()> {
    let success = format!("ok {reference}\n");
    let packets = packets(bytes)?;
    if packets.as_slice()
        != [
            Some(b"unpack ok\n".as_slice()),
            Some(success.as_bytes()),
            None,
        ]
    {
        return Err(io::Error::other(
            "Git server did not acknowledge exact capture ref and pack",
        ));
    }
    Ok(())
}

pub(crate) fn validate_ref(reference: &str) -> io::Result<()> {
    let branch = reference
        .strip_prefix("refs/heads/")
        .ok_or_else(|| io::Error::other("Capture target must be a branch ref"))?;
    if branch.is_empty()
        || reference.len() > 1024
        || reference.contains("..")
        || reference.contains("@{")
        || reference.ends_with('.')
        || reference
            .bytes()
            .any(|b| b <= 32 || b == 127 || b"~^:?*[\\".contains(&b))
        || branch
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(".lock"))
    {
        return Err(io::Error::other("Invalid frozen capture ref"));
    }
    Ok(())
}
#[cfg(test)]
pub(crate) fn advertisement_head(bytes: &[u8]) -> io::Result<String> {
    advertisement_ref(bytes, "refs/heads/main")
}
#[cfg(test)]
pub(crate) fn command_prefix(old: &str, new: &str) -> io::Result<Vec<u8>> {
    command_ref("refs/heads/main", old, new)
}
#[cfg(test)]
pub(crate) fn successful_report(bytes: &[u8]) -> io::Result<()> {
    successful_ref_report(bytes, "refs/heads/main")
}

pub(crate) fn validate_input_ref(reference: &str) -> io::Result<()> {
    let digest = reference
        .strip_prefix("refs/yoneda/source-input/")
        .ok_or_else(|| io::Error::other("Invalid private source input ref"))?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(io::Error::other(
            "Private source input ref requires a trusted job hash",
        ));
    }
    Ok(())
}
