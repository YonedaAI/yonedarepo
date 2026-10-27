//! Git's smart-HTTP protocol (v0, stateless RPC), the server side: ref advertisements,
//! receive-pack command lists, upload-pack want/have requests, report-status and
//! side-band framing. Everything here is framing and parsing; what a push or fetch may
//! do is decided by the platform.
use super::{ObjectId, invalid};
use crate::Result;

const ZERO: &str = "0000000000000000000000000000000000000000";
/// Side-band-64k carries at most 65520 bytes per packet, one of them the band.
const BAND_DATA: usize = 65515;

/// One pkt-line: four hex digits of length (itself included), then `data`.
pub fn pkt_line(data: &[u8]) -> Vec<u8> {
    let mut out = format!("{:04x}", data.len() + 4).into_bytes();
    out.extend_from_slice(data);
    out
}

pub const FLUSH: &[u8] = b"0000";

/// `data` on side-band `band` (1 pack or report, 2 progress text, 3 fatal error).
pub fn side_band(band: u8, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / BAND_DATA * 5 + 5);
    for chunk in data.chunks(BAND_DATA) {
        out.extend_from_slice(format!("{:04x}", chunk.len() + 5).as_bytes());
        out.push(band);
        out.extend_from_slice(chunk);
    }
    out
}

/// One pkt-line read from the front of a buffer: its payload (`None` for a flush) and the
/// bytes it took.
pub type Packet<'a> = (Option<&'a [u8]>, usize);

/// Reads the pkt-line at the front of `bytes`; `None` while it is not complete yet.
pub fn next_pkt(bytes: &[u8]) -> Result<Option<Packet<'_>>> {
    let Some(head) = bytes.get(..4) else {
        return Ok(None);
    };
    let len = std::str::from_utf8(head)
        .ok()
        .and_then(|h| usize::from_str_radix(h, 16).ok())
        .ok_or_else(|| invalid("Malformed pkt-line length"))?;
    match len {
        0 => Ok(Some((None, 4))),
        1..=3 => Err(invalid("Unexpected special pkt-line")),
        _ => Ok(bytes.get(4..len).map(|line| (Some(line), len))),
    }
}

fn text(line: &[u8]) -> Result<&str> {
    std::str::from_utf8(line)
        .map(|t| t.strip_suffix('\n').unwrap_or(t))
        .map_err(|_| invalid("pkt-line is not UTF-8"))
}

/// The body of `GET info/refs?service=<service>`: the service line, then each ref (the
/// first carrying the capabilities), or a capabilities-only line when there is none.
pub fn advertisement(service: &str, refs: &[(String, ObjectId)], capabilities: &str) -> Vec<u8> {
    let mut out = pkt_line(format!("# service={service}\n").as_bytes());
    out.extend_from_slice(FLUSH);
    if refs.is_empty() {
        out.extend(pkt_line(
            format!("{ZERO} capabilities^{{}}\0{capabilities}\n").as_bytes(),
        ));
    }
    for (i, (name, id)) in refs.iter().enumerate() {
        let line = if i == 0 {
            format!("{id} {name}\0{capabilities}\n")
        } else {
            format!("{id} {name}\n")
        };
        out.extend(pkt_line(line.as_bytes()));
    }
    out.extend_from_slice(FLUSH);
    out
}

/// One receive-pack command: `old` and `new` absent mean create and delete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefCommand {
    pub old: Option<ObjectId>,
    pub new: Option<ObjectId>,
    pub refname: String,
}

fn optional_id(hex: &str) -> Result<Option<ObjectId>> {
    if hex == ZERO {
        Ok(None)
    } else {
        ObjectId::parse(hex).map(Some)
    }
}

/// A ref name Git itself would accept (`git check-ref-format`), under `refs/`.
pub fn valid_ref_name(name: &str) -> bool {
    name.starts_with("refs/")
        && name.len() <= 1024
        && !name.ends_with('/')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && !name
            .chars()
            .any(|c| c.is_ascii_control() || " ~^:?*[\\".contains(c))
        && name.split('/').all(|part| !part.starts_with('.'))
}

/// The command list at the front of a receive-pack request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandList {
    pub commands: Vec<RefCommand>,
    /// What the client asked for on the first command.
    pub capabilities: Vec<String>,
    /// Bytes the list took (the pack follows).
    pub used: usize,
}

/// Parses the command list at the front of `bytes`; `None` until its closing flush.
pub fn command_list(bytes: &[u8]) -> Result<Option<CommandList>> {
    let mut at = 0;
    let mut commands = Vec::new();
    let mut capabilities = Vec::new();
    loop {
        let Some((line, used)) = next_pkt(&bytes[at..])? else {
            return Ok(None);
        };
        at += used;
        let Some(line) = line else {
            return Ok(Some(CommandList {
                commands,
                capabilities,
                used: at,
            }));
        };
        let (command, caps) = match line.iter().position(|b| *b == 0) {
            Some(nul) if commands.is_empty() => (&line[..nul], text(&line[nul + 1..])?),
            Some(_) => return Err(invalid("Capabilities after the first command")),
            None => (line, ""),
        };
        capabilities.extend(caps.split(' ').filter(|c| !c.is_empty()).map(str::to_owned));
        let command = text(command)?;
        if command.starts_with("shallow ") || command.starts_with("push-cert") {
            return Err(invalid("Shallow and signed pushes are not supported"));
        }
        let mut parts = command.split(' ');
        let (Some(old), Some(new), Some(refname), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(invalid("Malformed ref update command"));
        };
        if !valid_ref_name(refname) {
            return Err(invalid(format!("Invalid ref name {refname:?}")));
        }
        if commands.iter().any(|c: &RefCommand| c.refname == refname) {
            return Err(invalid(format!("{refname} is updated twice")));
        }
        commands.push(RefCommand {
            old: optional_id(old)?,
            new: optional_id(new)?,
            refname: refname.to_owned(),
        });
    }
}

/// An upload-pack request: what the client wants, what it has, and whether it is done
/// negotiating (then the answer carries the pack).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UploadRequest {
    pub wants: Vec<ObjectId>,
    pub haves: Vec<ObjectId>,
    pub capabilities: Vec<String>,
    pub done: bool,
}

pub fn upload_request(bytes: &[u8]) -> Result<UploadRequest> {
    let mut request = UploadRequest::default();
    let mut at = 0;
    let mut flushes = 0;
    while at < bytes.len() {
        let (line, used) = next_pkt(&bytes[at..])?.ok_or_else(|| invalid("Truncated request"))?;
        at += used;
        let Some(line) = line else {
            flushes += 1;
            continue;
        };
        let line = text(line)?;
        if let Some(rest) = line.strip_prefix("want ") {
            if flushes > 0 {
                return Err(invalid("want after the want list"));
            }
            let (id, caps) = rest.split_once(' ').unwrap_or((rest, ""));
            if request.wants.is_empty() {
                request.capabilities = caps
                    .split(' ')
                    .filter(|c| !c.is_empty())
                    .map(str::to_owned)
                    .collect();
            }
            request.wants.push(ObjectId::parse(id)?);
        } else if let Some(id) = line.strip_prefix("have ") {
            request.haves.push(ObjectId::parse(id)?);
        } else if line == "done" {
            request.done = true;
            break;
        } else if ["shallow ", "deepen", "filter "]
            .iter()
            .any(|p| line.starts_with(p))
        {
            return Err(invalid("Shallow and partial clones are not supported yet"));
        } else {
            return Err(invalid(format!("Unexpected upload-pack line {line:?}")));
        }
    }
    if request.wants.is_empty() {
        return Err(invalid("The request wants nothing"));
    }
    Ok(request)
}

/// Report-status: `unpack ok` (or the reason unpacking failed), then `ok <ref>` or
/// `ng <ref> <reason>` per ref, in the order given.
pub fn report_status(unpack: Option<&str>, refs: &[(String, Option<String>)]) -> Vec<u8> {
    let one_line = |s: &str| s.replace(['\n', '\r', '\0'], " ");
    let mut out = pkt_line(
        match unpack {
            None => b"unpack ok\n".to_vec(),
            Some(why) => format!("unpack {}\n", one_line(why)).into_bytes(),
        }
        .as_slice(),
    );
    for (refname, refused) in refs {
        let line = match refused {
            None => format!("ok {refname}\n"),
            Some(why) => format!("ng {refname} {}\n", one_line(why)),
        };
        out.extend(pkt_line(line.as_bytes()));
    }
    out.extend_from_slice(FLUSH);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(c: char) -> ObjectId {
        ObjectId::parse(&c.to_string().repeat(40)).unwrap()
    }

    #[test]
    fn parses_a_multi_command_push() {
        let mut body = pkt_line(
            format!(
                "{ZERO} {} refs/heads/a\0report-status atomic side-band-64k\n",
                id('a')
            )
            .as_bytes(),
        );
        body.extend(pkt_line(
            format!("{} {ZERO} refs/heads/b\n", id('b')).as_bytes(),
        ));
        body.extend_from_slice(FLUSH);
        body.extend_from_slice(b"PACK");
        assert_eq!(command_list(&body[..body.len() - 10]).unwrap(), None);
        let CommandList {
            commands,
            capabilities,
            used,
        } = command_list(&body).unwrap().unwrap();
        assert_eq!(&body[used..], b"PACK");
        assert_eq!(capabilities, ["report-status", "atomic", "side-band-64k"]);
        assert_eq!(commands[0].old, None);
        assert_eq!(commands[0].new, Some(id('a')));
        assert_eq!(commands[1].new, None);
        let twice = [
            pkt_line(format!("{ZERO} {} refs/heads/a\n", id('a')).as_bytes()),
            pkt_line(format!("{ZERO} {} refs/heads/a\n", id('b')).as_bytes()),
            FLUSH.to_vec(),
        ]
        .concat();
        assert!(command_list(&twice).is_err());
        let bad = [
            pkt_line(format!("{ZERO} {} refs/heads/../x\n", id('a')).as_bytes()),
            FLUSH.to_vec(),
        ]
        .concat();
        assert!(command_list(&bad).is_err());
    }

    #[test]
    fn parses_upload_requests() {
        let body = [
            pkt_line(format!("want {} side-band-64k ofs-delta\n", id('a')).as_bytes()),
            pkt_line(format!("want {}\n", id('b')).as_bytes()),
            FLUSH.to_vec(),
            pkt_line(format!("have {}\n", id('c')).as_bytes()),
            pkt_line(b"done\n"),
        ]
        .concat();
        let request = upload_request(&body).unwrap();
        assert_eq!(request.wants, [id('a'), id('b')]);
        assert_eq!(request.haves, [id('c')]);
        assert_eq!(request.capabilities, ["side-band-64k", "ofs-delta"]);
        assert!(request.done);
        let shallow = [
            pkt_line(format!("want {}\n", id('a')).as_bytes()),
            pkt_line(b"deepen 1\n"),
            FLUSH.to_vec(),
        ]
        .concat();
        assert!(upload_request(&shallow).is_err());
        assert!(upload_request(FLUSH).is_err());
    }

    #[test]
    fn frames_reports_and_bands() {
        let report = report_status(
            None,
            &[
                ("refs/heads/a".into(), None),
                ("refs/heads/b".into(), Some("stale\ninfo".into())),
            ],
        );
        let expected = [
            pkt_line(b"unpack ok\n"),
            pkt_line(b"ok refs/heads/a\n"),
            pkt_line(b"ng refs/heads/b stale info\n"),
            FLUSH.to_vec(),
        ]
        .concat();
        assert_eq!(report, expected);
        assert_eq!(&pkt_line(b"unpack ok\n")[..4], b"000e");
        let banded = side_band(2, &vec![b'x'; BAND_DATA + 1]);
        assert_eq!(&banded[..5], b"fff0\x02");
        assert_eq!(banded.len(), BAND_DATA + 1 + 10);
        let advertised = advertisement("git-upload-pack", &[], "report-status");
        assert!(advertised.ends_with(b"capabilities^{}\0report-status\n0000"));
    }
}
