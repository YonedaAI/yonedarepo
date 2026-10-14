//! Minimal Git v0 negotiation: one exact want, one exact common base, no side-band or shallow state.
use crate::{source_git_tree::validate_oid, source_refresh_plan::error};
use yoneda_core::Result;
pub(crate) fn packet(bytes: &[u8]) -> Vec<u8> {
    let mut out = format!("{:04x}", bytes.len() + 4).into_bytes();
    out.extend(bytes);
    out
}
pub(crate) fn request(discovery: &[u8], candidate: &str, base: &str) -> Result<Vec<u8>> {
    for oid in [candidate, base] {
        validate_oid(oid).map_err(|_| error("Negotiated closure requires SHA-1"))?;
    }
    let mut bytes = discovery;
    let mut lines = Vec::new();
    if bytes.len() > 1024 * 1024 {
        return Err(error("Upload-pack discovery exceeds bound"));
    }
    while !bytes.is_empty() {
        let h = bytes
            .get(..4)
            .ok_or_else(|| error("Truncated upload-pack discovery"))?;
        let n = usize::from_str_radix(
            std::str::from_utf8(h).map_err(|_| error("Invalid upload-pack packet"))?,
            16,
        )
        .map_err(|_| error("Invalid upload-pack packet"))?;
        if n == 0 {
            lines.push(None);
            bytes = &bytes[4..];
            continue;
        }
        if !(4..=65520).contains(&n) {
            return Err(error("Invalid upload-pack packet length"));
        }
        lines.push(Some(
            bytes
                .get(4..n)
                .ok_or_else(|| error("Truncated upload-pack packet"))?,
        ));
        bytes = &bytes[n..];
    }
    if lines.first() != Some(&Some(b"# service=git-upload-pack\n".as_slice()))
        || lines.get(1) != Some(&None)
        || lines.last() != Some(&None)
    {
        return Err(error("Not smart upload-pack discovery"));
    }
    let first = lines
        .get(2)
        .and_then(|v| *v)
        .ok_or_else(|| error("Upload-pack source refs missing"))?;
    let split = first
        .iter()
        .position(|b| *b == 0)
        .ok_or_else(|| error("Upload-pack capabilities missing"))?;
    let caps = &first[split + 1..];
    let caps = std::str::from_utf8(caps)
        .map_err(|_| error("Invalid upload-pack capabilities"))?
        .split_ascii_whitespace()
        .collect::<Vec<_>>();
    if !caps.contains(&"thin-pack")
        || caps
            .iter()
            .any(|c| c.starts_with("object-format=") && *c != "object-format=sha1")
    {
        return Err(error("Source cannot provide bounded SHA-1 difference pack"));
    }
    let advertised = lines
        .iter()
        .flatten()
        .any(|line| line.starts_with(format!("{candidate} ").as_bytes()));
    if !advertised
        && !caps.contains(&"allow-tip-sha1-in-want")
        && !caps.contains(&"allow-reachable-sha1-in-want")
    {
        return Err(error("Frozen candidate cannot be requested from discovery"));
    }
    let capability = if caps.contains(&"ofs-delta") {
        "thin-pack ofs-delta"
    } else {
        "thin-pack"
    };
    let mut out = packet(format!("want {candidate} {capability}\n").as_bytes());
    out.extend(b"0000");
    out.extend(packet(format!("have {base}\n").as_bytes()));
    out.extend(packet(b"done\n"));
    Ok(out)
}
pub(crate) fn acknowledged_prefix(bytes: &[u8], base: &str) -> Result<Option<usize>> {
    let ack = packet(format!("ACK {base}\n").as_bytes());
    if bytes.len() < ack.len() + 12 {
        return Ok(None);
    }
    if !bytes.starts_with(&ack)
        || &bytes[ack.len()..ack.len() + 4] != b"PACK"
        || bytes[ack.len() + 4..ack.len() + 8] != [0, 0, 0, 2]
    {
        return Err(error("Source did not ACK the exact base before its pack"));
    }
    Ok(Some(ack.len()))
}
