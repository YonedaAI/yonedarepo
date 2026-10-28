//! One receive-pack carrying several of the platform's single-ref pushes. Artifacts accepts
//! one receive-pack per repository at a time, so pushes that arrive together share one
//! request: their objects in one pack, one command per ref, and Git's per-ref report split
//! back so each caller verifies only its own ref.
use super::protocol::{parse_receive_pack_request, receive_pack_report, report_lines};
use crate::Result;
use crate::git_object::{PackLimits, hash_object, invalid, read_pack, write_pack};
use std::collections::BTreeSet;

fn pkt(line: &str) -> String {
    format!("{:04x}{line}", line.len() + 4)
}

/// Combines single-ref push bodies (creates, updates or deletes) into one request. Returns
/// the body and each input's ref, in input order. Two inputs for one ref are refused: Git
/// rejects duplicate commands in a push.
pub fn combine_receive_pack_requests(bodies: &[&[u8]]) -> Result<(Vec<u8>, Vec<String>)> {
    let zero = "0".repeat(40);
    let mut refs = Vec::with_capacity(bodies.len());
    let mut commands = Vec::with_capacity(bodies.len());
    let mut seen_refs = BTreeSet::new();
    let mut seen_objects = BTreeSet::new();
    let mut objects = Vec::new();
    let mut deletes = false;
    for body in bodies {
        let push = parse_receive_pack_request(body)?;
        if !seen_refs.insert(push.refname.clone()) {
            return Err(invalid(format!(
                "Ref {} appears twice in one push",
                push.refname
            )));
        }
        let new = push.new.hex();
        deletes |= new == zero;
        if !push.pack.is_empty() {
            for (kind, data) in read_pack(push.pack, PackLimits::default())? {
                if seen_objects.insert(hash_object(kind, &data)) {
                    objects.push((kind, data));
                }
            }
        }
        let old = push.old.map_or_else(|| zero.clone(), |id| id.hex());
        commands.push(format!("{old} {new} {}", push.refname));
        refs.push(push.refname);
    }
    let capabilities = if deletes {
        "report-status delete-refs"
    } else {
        "report-status"
    };
    let mut out = String::new();
    for (i, command) in commands.iter().enumerate() {
        out.push_str(&pkt(&if i == 0 {
            format!("{command}\0{capabilities}\n")
        } else {
            format!("{command}\n")
        }));
    }
    let mut out = out.into_bytes();
    out.extend_from_slice(b"0000");
    if commands
        .iter()
        .any(|c| !c.split(' ').nth(1).is_some_and(|new| new == zero))
    {
        let refs: Vec<_> = objects.iter().map(|(k, d)| (*k, d.as_slice())).collect();
        out.extend_from_slice(&write_pack(&refs)?);
    }
    Ok((out, refs))
}

/// The single-ref report `refname` would have received had it been pushed alone. A failed
/// unpack refuses every ref; a ref missing from the report is an error, never success.
pub fn split_receive_pack_report(report: &[u8], refname: &str) -> Result<Vec<u8>> {
    let lines = report_lines(report)?;
    let text = |line: &[u8]| String::from_utf8_lossy(line).trim_end().to_owned();
    match lines.first() {
        Some(Some(b"unpack ok\n")) => {}
        Some(Some(line)) => {
            let reason = format!("unpack failed: {}", text(line));
            return Ok(receive_pack_report(refname, Some(&reason)));
        }
        _ => return Err(invalid("Empty push report")),
    }
    let ok = format!("ok {refname}");
    let ng = format!("ng {refname} ");
    for line in lines.iter().skip(1).flatten() {
        let line = text(line);
        if line == ok {
            return Ok(receive_pack_report(refname, None));
        }
        if let Some(reason) = line.strip_prefix(&ng) {
            return Ok(receive_pack_report(refname, Some(reason)));
        }
    }
    Err(invalid(format!("Push report has no status for {refname}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_object::{ObjectId, ObjectKind};
    use crate::transport::{
        receive_pack_delete, receive_pack_outcome, receive_pack_request, verify_receive_pack_report,
    };

    fn push(name: &str, blob: &[u8]) -> (Vec<u8>, ObjectId) {
        let id = hash_object(ObjectKind::Blob, blob);
        let pack = write_pack(&[(ObjectKind::Blob, blob), (ObjectKind::Blob, b"shared")]).unwrap();
        (
            receive_pack_request(&format!("refs/yoneda/c/{name}"), None, id, &pack).unwrap(),
            id,
        )
    }

    #[test]
    fn combines_commands_and_deduplicates_objects() {
        let (a, a_id) = push("a", b"one");
        let (b, _) = push("b", b"two");
        let gone = hash_object(ObjectKind::Blob, b"old");
        let delete = receive_pack_delete("refs/yoneda/c/old", gone).unwrap();
        let (body, refs) = combine_receive_pack_requests(&[&a, &b, &delete]).unwrap();
        assert_eq!(
            refs,
            ["refs/yoneda/c/a", "refs/yoneda/c/b", "refs/yoneda/c/old"]
        );
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains(&format!(
            "{} {a_id} refs/yoneda/c/a\0report-status delete-refs\n",
            "0".repeat(40)
        )));
        assert!(text.contains(&format!("{gone} {} refs/yoneda/c/old\n", "0".repeat(40))));
        let pack = &body[body.windows(4).position(|w| w == b"PACK").unwrap()..];
        // "shared" appears in both inputs but once in the combined pack.
        assert_eq!(read_pack(pack, PackLimits::default()).unwrap().len(), 3);
        assert!(combine_receive_pack_requests(&[&a, &a]).is_err());
    }

    #[test]
    fn delete_only_batches_carry_no_pack() {
        let gone = hash_object(ObjectKind::Blob, b"old");
        let delete = receive_pack_delete("refs/yoneda/c/old", gone).unwrap();
        let (body, _) = combine_receive_pack_requests(&[&delete]).unwrap();
        assert!(body.ends_with(b"0000"));
        assert!(!body.windows(4).any(|w| w == b"PACK"));
    }

    #[test]
    fn splits_a_combined_report_per_ref() {
        let report =
            b"000eunpack ok\n0017ok refs/yoneda/c/a\n0022ng refs/yoneda/c/b stale info\n0000";
        let a = split_receive_pack_report(report, "refs/yoneda/c/a").unwrap();
        verify_receive_pack_report(&a, "refs/yoneda/c/a").unwrap();
        let b = split_receive_pack_report(report, "refs/yoneda/c/b").unwrap();
        assert_eq!(
            receive_pack_outcome(&b, "refs/yoneda/c/b").unwrap(),
            Some("stale info".into())
        );
        assert!(split_receive_pack_report(report, "refs/yoneda/c/z").is_err());
        let failed = b"001bunpack index-pack died\n0000";
        let refused = split_receive_pack_report(failed, "refs/yoneda/c/a").unwrap();
        assert!(verify_receive_pack_report(&refused, "refs/yoneda/c/a").is_err());
    }
}
