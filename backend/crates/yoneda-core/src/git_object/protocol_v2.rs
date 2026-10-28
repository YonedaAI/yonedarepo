//! Git's wire protocol version 2 (gitprotocol-v2), the server side of upload-pack over
//! smart HTTP: the capability advertisement, `ls-refs` and `fetch` requests, and the
//! sections of their answers. Partial clones (`filter blob:none`) and shallow ones
//! (`deepen`, `deepen-relative`) are parsed here; which objects a fetch sends is decided by
//! the platform.
use super::smart_http::{FLUSH, pkt_line};
use super::{ObjectId, invalid};
use crate::Result;

/// Ends a request's capability list and separates the sections of an answer.
pub const DELIM: &[u8] = b"0001";
/// `deepen 2147483647` is how Git asks for the whole history (`--unshallow`).
pub const INFINITE_DEPTH: u32 = 0x7fff_ffff;
const MAX_PREFIXES: usize = 256;
const MAX_IDS: usize = 100_000;

/// The answer to `GET info/refs` from a client that asked for version 2: the commands
/// this server runs and what each accepts.
pub fn v2_capabilities(agent: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for line in [
        "version 2",
        agent,
        "ls-refs",
        "fetch=shallow filter",
        "object-format=sha1",
    ] {
        out.extend(pkt_line(format!("{line}\n").as_bytes()));
    }
    out.extend_from_slice(FLUSH);
    out
}

/// `ls-refs` arguments: refs under any of `prefixes` (all when empty), with HEAD's target
/// when `symrefs`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LsRefs {
    pub symrefs: bool,
    pub prefixes: Vec<String>,
}

/// `fetch` arguments. `shallows` are the client's shallow commits (it holds each but not
/// its parents); `depth` with `deepen_relative` counts from them instead of the wants.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FetchArgs {
    pub wants: Vec<ObjectId>,
    pub haves: Vec<ObjectId>,
    pub shallows: Vec<ObjectId>,
    pub depth: Option<u32>,
    pub deepen_relative: bool,
    /// `filter blob:none`: send no blob the client did not want by id.
    pub omit_blobs: bool,
    pub done: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum V2Command {
    LsRefs(LsRefs),
    Fetch(FetchArgs),
}

/// One pkt-line of a v2 request: `Line`, `Flush` (0000) or `Delim` (0001).
enum Pkt<'a> {
    Line(&'a str),
    Flush,
    Delim,
}

fn read<'a>(bytes: &'a [u8], at: &mut usize) -> Result<Pkt<'a>> {
    let head = bytes
        .get(*at..*at + 4)
        .ok_or_else(|| invalid("Truncated request"))?;
    let len = std::str::from_utf8(head)
        .ok()
        .and_then(|h| usize::from_str_radix(h, 16).ok())
        .ok_or_else(|| invalid("Malformed pkt-line length"))?;
    let start = *at;
    *at += 4;
    match len {
        0 => Ok(Pkt::Flush),
        1 => Ok(Pkt::Delim),
        2..=3 => Err(invalid("Unexpected special pkt-line")),
        _ => {
            let line = bytes
                .get(start + 4..start + len)
                .ok_or_else(|| invalid("Truncated request"))?;
            *at = start + len;
            let text = std::str::from_utf8(line).map_err(|_| invalid("pkt-line is not UTF-8"))?;
            Ok(Pkt::Line(text.strip_suffix('\n').unwrap_or(text)))
        }
    }
}

/// A v2 upload-pack request: `command=<name>`, capability lines, a delimiter, then the
/// command's arguments up to a flush.
pub fn v2_request(bytes: &[u8]) -> Result<V2Command> {
    let mut at = 0;
    let Pkt::Line(first) = read(bytes, &mut at)? else {
        return Err(invalid("A version 2 request starts with command=<name>"));
    };
    let command = first
        .strip_prefix("command=")
        .ok_or_else(|| invalid("A version 2 request starts with command=<name>"))?
        .to_owned();
    // Capabilities (agent, object-format, server options) change nothing here.
    let mut args = Vec::new();
    let mut in_args = false;
    loop {
        match read(bytes, &mut at)? {
            Pkt::Line(line) if in_args => args.push(line),
            Pkt::Line(line) => {
                if let Some(format) = line.strip_prefix("object-format=")
                    && format != "sha1"
                {
                    return Err(invalid(format!("Object format {format} is not served")));
                }
            }
            Pkt::Delim if !in_args => in_args = true,
            Pkt::Delim => return Err(invalid("Unexpected delimiter")),
            Pkt::Flush => break,
        }
    }
    match command.as_str() {
        "ls-refs" => ls_refs(&args).map(V2Command::LsRefs),
        "fetch" => fetch(&args).map(V2Command::Fetch),
        other => Err(invalid(format!("Unknown command {other:?}"))),
    }
}

fn ls_refs(args: &[&str]) -> Result<LsRefs> {
    let mut request = LsRefs::default();
    for arg in args {
        match *arg {
            "symrefs" => request.symrefs = true,
            // Tags are lightweight (nothing to peel) and HEAD is always born when listed.
            "peel" | "unborn" => {}
            _ => match arg.strip_prefix("ref-prefix ") {
                Some(prefix) if request.prefixes.len() < MAX_PREFIXES => {
                    request.prefixes.push(prefix.to_owned())
                }
                Some(_) => return Err(invalid("Too many ref prefixes")),
                None => return Err(invalid(format!("Unexpected ls-refs argument {arg:?}"))),
            },
        }
    }
    Ok(request)
}

fn fetch(args: &[&str]) -> Result<FetchArgs> {
    let mut request = FetchArgs::default();
    let push = |list: &mut Vec<ObjectId>, hex: &str| {
        if list.len() == MAX_IDS {
            return Err(invalid("Too many object ids in one request"));
        }
        list.push(ObjectId::parse(hex)?);
        Ok(())
    };
    for arg in args {
        let (key, value) = arg.split_once(' ').unwrap_or((arg, ""));
        match key {
            "want" => push(&mut request.wants, value)?,
            "have" => push(&mut request.haves, value)?,
            "shallow" => push(&mut request.shallows, value)?,
            "done" => request.done = true,
            "deepen" => {
                let depth = value
                    .parse::<u32>()
                    .ok()
                    .filter(|d| *d > 0)
                    .ok_or_else(|| invalid(format!("Invalid depth {value:?}")))?;
                request.depth = Some(depth.min(INFINITE_DEPTH));
            }
            "deepen-relative" => request.deepen_relative = true,
            "filter" if value == "blob:none" => request.omit_blobs = true,
            "filter" => {
                return Err(invalid(format!(
                    "Filter {value:?} is not served; use --filter=blob:none"
                )));
            }
            "deepen-since" | "deepen-not" => {
                return Err(invalid(format!(
                    "{key} is not served; use --depth or --deepen"
                )));
            }
            // Packs are never thin and carry no progress or deltas, so these change nothing.
            "thin-pack" | "no-progress" | "include-tag" | "ofs-delta" => {}
            _ => return Err(invalid(format!("Unexpected fetch argument {arg:?}"))),
        }
    }
    if request.wants.is_empty() {
        return Err(invalid("The request wants nothing"));
    }
    Ok(request)
}

/// The `ls-refs` answer: one line per ref, HEAD with its target when asked.
pub fn ls_refs_answer(refs: &[(String, ObjectId, Option<String>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, id, target) in refs {
        let line = match target {
            Some(target) => format!("{id} {name} symref-target:{target}\n"),
            None => format!("{id} {name}\n"),
        };
        out.extend(pkt_line(line.as_bytes()));
    }
    out.extend_from_slice(FLUSH);
    out
}

/// The sections of a `fetch` answer that come before the pack's side-band data.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FetchHead {
    /// Haves acknowledged in a negotiation round (`None` once the client said `done`).
    pub acknowledged: Option<Vec<ObjectId>>,
    /// Whether the answer carries a `shallow-info` section.
    pub shallow_info: bool,
    pub shallow: Vec<ObjectId>,
    pub unshallow: Vec<ObjectId>,
}

impl FetchHead {
    /// A round without a common commit: NAK, and the client sends more haves.
    pub fn nak() -> Vec<u8> {
        let mut out = pkt_line(b"acknowledgments\n");
        out.extend(pkt_line(b"NAK\n"));
        out.extend_from_slice(FLUSH);
        out
    }

    /// The acknowledgments (ending `ready`), the shallow-info, and the `packfile` header;
    /// the pack follows on side-band 1, then a flush.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if let Some(common) = &self.acknowledged {
            out.extend(pkt_line(b"acknowledgments\n"));
            for id in common {
                out.extend(pkt_line(format!("ACK {id}\n").as_bytes()));
            }
            out.extend(pkt_line(b"ready\n"));
            out.extend_from_slice(DELIM);
        }
        if self.shallow_info {
            out.extend(pkt_line(b"shallow-info\n"));
            for id in &self.shallow {
                out.extend(pkt_line(format!("shallow {id}\n").as_bytes()));
            }
            for id in &self.unshallow {
                out.extend(pkt_line(format!("unshallow {id}\n").as_bytes()));
            }
            out.extend_from_slice(DELIM);
        }
        out.extend(pkt_line(b"packfile\n"));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(c: char) -> ObjectId {
        ObjectId::parse(&c.to_string().repeat(40)).unwrap()
    }

    fn request(command: &str, args: &[String]) -> Vec<u8> {
        let mut body = pkt_line(format!("command={command}\n").as_bytes());
        body.extend(pkt_line(b"agent=git/2.47.0\n"));
        body.extend(pkt_line(b"object-format=sha1\n"));
        body.extend_from_slice(DELIM);
        for arg in args {
            body.extend(pkt_line(format!("{arg}\n").as_bytes()));
        }
        body.extend_from_slice(FLUSH);
        body
    }

    #[test]
    fn advertises_ls_refs_and_fetch_with_shallow_and_filter() {
        let text = String::from_utf8(v2_capabilities("agent=yonedarepo/1")).unwrap();
        assert!(text.starts_with("000eversion 2\n"));
        assert!(text.contains("ls-refs\n"));
        assert!(text.contains("fetch=shallow filter\n"));
        assert!(text.contains("object-format=sha1\n"));
        assert!(text.ends_with("0000"));
    }

    #[test]
    fn parses_ls_refs() {
        let args = [
            "peel",
            "symrefs",
            "unborn",
            "ref-prefix HEAD",
            "ref-prefix refs/heads/",
        ]
        .map(String::from);
        let V2Command::LsRefs(request) = v2_request(&request("ls-refs", &args)).unwrap() else {
            panic!("not ls-refs");
        };
        assert!(request.symrefs);
        assert_eq!(request.prefixes, ["HEAD", "refs/heads/"]);
        let bare = [pkt_line(b"command=ls-refs\n"), FLUSH.to_vec()].concat();
        assert_eq!(
            v2_request(&bare).unwrap(),
            V2Command::LsRefs(LsRefs::default())
        );
    }

    #[test]
    fn parses_partial_and_shallow_fetches() {
        let args = [
            "thin-pack".to_owned(),
            "ofs-delta".to_owned(),
            "deepen 3".to_owned(),
            "deepen-relative".to_owned(),
            "filter blob:none".to_owned(),
            format!("shallow {}", id('c')),
            format!("want {}", id('a')),
            format!("want {}", id('b')),
            format!("have {}", id('c')),
            "done".to_owned(),
        ];
        let V2Command::Fetch(fetch) = v2_request(&request("fetch", &args)).unwrap() else {
            panic!("not fetch");
        };
        assert_eq!(fetch.wants, [id('a'), id('b')]);
        assert_eq!(fetch.haves, [id('c')]);
        assert_eq!(fetch.shallows, [id('c')]);
        assert_eq!(fetch.depth, Some(3));
        assert!(fetch.deepen_relative && fetch.omit_blobs && fetch.done);
        let unshallow = [format!("want {}", id('a')), "deepen 2147483647".to_owned()];
        let V2Command::Fetch(full) = v2_request(&request("fetch", &unshallow)).unwrap() else {
            panic!("not fetch");
        };
        assert_eq!(full.depth, Some(INFINITE_DEPTH));
    }

    #[test]
    fn refuses_what_it_does_not_serve() {
        let want = format!("want {}", id('a'));
        for arg in [
            "filter tree:0",
            "deepen-since 1700000000",
            "deepen 0",
            "want-ref refs/heads/main",
        ] {
            let err = v2_request(&request("fetch", &[want.clone(), arg.to_owned()])).unwrap_err();
            assert_eq!(err.code, "GIT_OBJECT_INVALID", "{arg}");
        }
        assert!(v2_request(&request("fetch", &["done".to_owned()])).is_err());
        assert!(v2_request(&request("object-info", &[])).is_err());
        assert!(v2_request(&pkt_line(b"command=fetch\n")).is_err());
        let sha256 = [
            pkt_line(b"command=ls-refs\n"),
            pkt_line(b"object-format=sha256\n"),
            FLUSH.to_vec(),
        ]
        .concat();
        assert!(v2_request(&sha256).is_err());
    }

    #[test]
    fn frames_fetch_answers() {
        assert_eq!(FetchHead::nak(), b"0014acknowledgments\n0008NAK\n0000");
        let head = FetchHead {
            acknowledged: Some(vec![id('c')]),
            shallow_info: true,
            shallow: vec![id('d')],
            unshallow: vec![id('c')],
        };
        let expected = [
            pkt_line(b"acknowledgments\n"),
            pkt_line(format!("ACK {}\n", id('c')).as_bytes()),
            pkt_line(b"ready\n"),
            DELIM.to_vec(),
            pkt_line(b"shallow-info\n"),
            pkt_line(format!("shallow {}\n", id('d')).as_bytes()),
            pkt_line(format!("unshallow {}\n", id('c')).as_bytes()),
            DELIM.to_vec(),
            pkt_line(b"packfile\n"),
        ]
        .concat();
        assert_eq!(head.encode(), expected);
        assert_eq!(FetchHead::default().encode(), pkt_line(b"packfile\n"));
        let listed = ls_refs_answer(&[
            ("HEAD".into(), id('a'), Some("refs/heads/main".into())),
            ("refs/heads/main".into(), id('a'), None),
        ]);
        let text = String::from_utf8(listed).unwrap();
        assert!(text.contains(&format!("{} HEAD symref-target:refs/heads/main\n", id('a'))));
        assert!(text.ends_with(&format!("{} refs/heads/main\n0000", id('a'))));
    }
}
