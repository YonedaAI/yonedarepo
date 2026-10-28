//! Smart-HTTP framing as compute ops for the adapter: ref advertisements, upload-pack
//! requests and negotiation answers, and push reports (on side-band when asked).
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Result,
    git_object::{
        FLUSH, ObjectId, advertisement, pkt_line, report_status, side_band, upload_request,
    },
};

pub(crate) const AGENT: &str = "agent=yonedarepo/1";
const UPLOAD_CAPABILITIES: &str = "multi_ack_detailed side-band-64k side-band no-progress";
/// `no-thin`: every delta base is in the pack, so a push never depends on objects the
/// server would have to look up while it unpacks. `push-options`: `-o yoneda.reads=…`
/// declares the push's read set (`platform_push_reads`).
const RECEIVE_CAPABILITIES: &str =
    "report-status delete-refs atomic ofs-delta no-thin side-band-64k quiet push-options";
const MAIN: &str = "refs/heads/main";
const MAX_HAVES: usize = 256;

/// `git_advertise`: `{service, refs: {name: id}, haves}` → the `info/refs` body, branches
/// and tags in name order behind `HEAD` (main, when it exists). Tags are lightweight, so
/// each names its commit and needs no peeled line.
///
/// A push lists no protected branch. They move only by landing, which merges work based on
/// an older head instead of refusing it, so Git must not refuse that push as
/// non-fast-forward first: it sends the update as a creation and the server lands it (a
/// forced push lands the same way, so it can never rewrite them). Their recent heads
/// (`haves`) are listed as `.have` lines instead, which Git leaves out of the pack, so a
/// client a few landings behind still sends only its own work.
pub fn advertise(c: &Value) -> Result<Value> {
    let service = string(c, "service")?;
    let push = service == "git-receive-pack";
    let mut refs: Vec<(String, ObjectId)> = Vec::new();
    for (name, id) in c["refs"].as_object().into_iter().flatten() {
        let listed = name.starts_with("refs/heads/") || name.starts_with("refs/tags/");
        if listed && !(push && crate::repo_store::protected_ref(name)) {
            refs.push((
                name.clone(),
                ObjectId::parse(id.as_str().unwrap_or_default())?,
            ));
        }
    }
    let mut haves = Vec::new();
    for id in c["haves"].as_array().into_iter().flatten().take(MAX_HAVES) {
        let id = ObjectId::parse(id.as_str().unwrap_or_default())?;
        if push && !haves.contains(&id) && !refs.iter().any(|(_, r)| *r == id) {
            haves.push(id);
        }
    }
    refs.sort();
    let main = refs
        .iter()
        .find(|(name, _)| name == MAIN)
        .map(|(_, id)| *id);
    let capabilities = match service.as_str() {
        "git-upload-pack" => {
            // Git takes HEAD's target from the symref to pick the branch it checks out.
            let mut caps = UPLOAD_CAPABILITIES.to_owned();
            if main.is_some() {
                caps.push_str(" symref=HEAD:refs/heads/main");
            }
            if let Some(id) = main {
                refs.insert(0, ("HEAD".into(), id));
            }
            format!("{caps} {AGENT}")
        }
        "git-receive-pack" => {
            refs.extend(haves.into_iter().map(|id| (".have".to_owned(), id)));
            format!("{RECEIVE_CAPABILITIES} {AGENT}")
        }
        _ => return Err(bad("Unknown Git service")),
    };
    Ok(json!({ "body_b64": STANDARD.encode(advertisement(&service, &refs, &capabilities)) }))
}

/// An upload-pack request body (`body_b64`). Not a `string` field: a negotiation round or
/// a checkout's wants run to megabytes, bounded by the adapter's request limit.
pub(crate) fn request_body(c: &Value) -> Result<Vec<u8>> {
    let encoded = c["body_b64"]
        .as_str()
        .ok_or_else(|| bad("Missing or invalid body_b64"))?;
    STANDARD
        .decode(encoded)
        .map_err(|_| bad("body_b64 is not base64"))
}

/// `git_upload_request`: an upload-pack request body → `{wants, haves, capabilities, done}`.
pub fn parse_upload(c: &Value) -> Result<Value> {
    let request = upload_request(&request_body(c)?)?;
    Ok(json!({
        "wants": request.wants, "haves": request.haves,
        "capabilities": request.capabilities, "done": request.done,
    }))
}

/// `git_acknowledge`: the negotiation answer for `{common, done, detailed}`, where
/// `common` lists the client's haves this repository has, in request order. With
/// multi_ack_detailed each is acknowledged as common, and the round ends with NAK (the
/// client resends them with `done`) or, when done, the last one acknowledged. Without it,
/// only the first is acknowledged, and NAK means none.
pub fn acknowledge(c: &Value) -> Result<Value> {
    let common = c["common"]
        .as_array()
        .ok_or_else(|| bad("common must be a list"))?
        .iter()
        .map(|id| ObjectId::parse(id.as_str().unwrap_or_default()))
        .collect::<Result<Vec<_>>>()?;
    let done = c["done"] == true;
    let mut lines = Vec::new();
    if c["detailed"] == true {
        lines.extend(common.iter().map(|id| format!("ACK {id} common\n")));
        lines.push(match common.last() {
            Some(last) if done => format!("ACK {last}\n"),
            _ => "NAK\n".to_owned(),
        });
    } else {
        match common.first() {
            Some(first) => lines.push(format!("ACK {first}\n")),
            None => lines.push("NAK\n".to_owned()),
        }
    }
    let body: Vec<u8> = lines.iter().flat_map(|l| pkt_line(l.as_bytes())).collect();
    Ok(json!({ "body_b64": STANDARD.encode(body) }))
}

/// `git_report`: `{unpack, refs: [{ref, refused}], side_band, messages}` → the push's
/// answer: report-status, wrapped in side-band 1 (with `messages` on band 2 first) when
/// the client asked for side-band-64k.
pub fn report(c: &Value) -> Result<Value> {
    let refs: Vec<(String, Option<String>)> = c["refs"]
        .as_array()
        .ok_or_else(|| bad("refs must be a list"))?
        .iter()
        .map(|r| Ok((string(r, "ref")?, r["refused"].as_str().map(str::to_owned))))
        .collect::<Result<_>>()?;
    let status = report_status(c["unpack"].as_str(), &refs);
    if c["side_band"] != true {
        return Ok(json!({ "body_b64": STANDARD.encode(status) }));
    }
    let mut out = Vec::new();
    for message in c["messages"].as_array().into_iter().flatten() {
        let text = message
            .as_str()
            .unwrap_or_default()
            .replace(['\r', '\0'], " ");
        out.extend(side_band(2, format!("{}\n", text.trim_end()).as_bytes()));
    }
    out.extend(side_band(1, &status));
    out.extend_from_slice(FLUSH);
    Ok(json!({ "body_b64": STANDARD.encode(out) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_long_negotiation() {
        // A stateless round resends every common have: well past 16 KiB.
        let mut body = pkt_line(format!("want {} side-band-64k\n", "a".repeat(40)).as_bytes());
        body.extend_from_slice(FLUSH);
        for i in 0..1_000u32 {
            body.extend(pkt_line(format!("have {:040x}\n", i + 1).as_bytes()));
        }
        body.extend(pkt_line(b"done\n"));
        let parsed = parse_upload(&json!({ "body_b64": STANDARD.encode(body) })).unwrap();
        assert_eq!(parsed["haves"].as_array().unwrap().len(), 1_000);
    }

    #[test]
    fn advertises_head_as_main_and_reports_on_side_band() {
        let main = "a".repeat(40);
        let body = advertise(&json!({
            "service": "git-upload-pack",
            "refs": { "refs/heads/main": main, "refs/heads/x": "b".repeat(40), "refs/yoneda/c/z": main,
                      "refs/tags/v1": main },
        }))
        .unwrap();
        let text = String::from_utf8(STANDARD.decode(body["body_b64"].as_str().unwrap()).unwrap())
            .unwrap();
        assert!(text.contains(&format!("{main} refs/tags/v1\n")));
        assert!(text.starts_with("001e# service=git-upload-pack\n0000"));
        assert!(text.contains(&format!("{main} HEAD\0multi_ack_detailed side-band-64k")));
        assert!(text.contains("symref=HEAD:refs/heads/main"));
        assert!(text.contains("refs/heads/x\n") && !text.contains("refs/yoneda"));
        let pushed = advertise(&json!({
            "service": "git-receive-pack",
            "refs": { "refs/heads/main": main, "refs/heads/release/1": main, "refs/heads/x": "b".repeat(40),
                      "refs/tags/v1": "c".repeat(40) },
            "haves": [main, main, "b".repeat(40)],
        }))
        .unwrap();
        let text = String::from_utf8(
            STANDARD
                .decode(pushed["body_b64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert!(text.contains("refs/heads/x\0report-status") && !text.contains("refs/heads/main"));
        assert!(
            text.contains("refs/tags/v1\n"),
            "a push sees tags, so Git keeps them"
        );
        assert_eq!(text.matches(&format!("{main} .have\n")).count(), 1);
        let report = report(&json!({
            "refs": [{ "ref": "refs/heads/main", "refused": null }],
            "side_band": true, "messages": ["landed with server merge, run git pull"],
        }))
        .unwrap();
        let bytes = STANDARD
            .decode(report["body_b64"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes[4], 2);
        assert!(bytes.ends_with(b"0000"));
        let ack = acknowledge(&json!({ "common": [], "done": true, "detailed": true })).unwrap();
        assert_eq!(
            STANDARD.decode(ack["body_b64"].as_str().unwrap()).unwrap(),
            b"0008NAK\n"
        );
        let both = acknowledge(
            &json!({ "common": [main, "b".repeat(40)], "done": true, "detailed": true }),
        )
        .unwrap();
        let text = String::from_utf8(STANDARD.decode(both["body_b64"].as_str().unwrap()).unwrap())
            .unwrap();
        assert_eq!(
            text,
            format!(
                "0038ACK {main} common\n0038ACK {} common\n0031ACK {}\n",
                "b".repeat(40),
                "b".repeat(40)
            )
        );
    }
}
