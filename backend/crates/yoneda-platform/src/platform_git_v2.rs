//! Git protocol version 2 over smart HTTP as compute ops for the adapter, upload-pack
//! only (Git pushes with version 0): the capability advertisement, request parsing, the
//! `ls-refs` answer and the sections before a fetch's pack. Partial (`filter blob:none`)
//! and shallow (`deepen`) fetches are served on version 2 alone; a client that does not
//! ask for it keeps version 0 (`platform_git_http`).
use crate::platform_git_http::{AGENT, request_body};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Result,
    git_object::{FetchHead, ObjectId, V2Command, ls_refs_answer, v2_capabilities, v2_request},
};

const MAIN: &str = "refs/heads/main";

fn encoded(body: Vec<u8>) -> Value {
    json!({ "body_b64": STANDARD.encode(body) })
}

fn id_list(c: &Value, key: &str) -> Result<Vec<ObjectId>> {
    c[key]
        .as_array()
        .into_iter()
        .flatten()
        .map(|id| ObjectId::parse(id.as_str().unwrap_or_default()))
        .collect()
}

/// `git_v2_capabilities`: the `info/refs` body for a version 2 client.
pub fn capabilities(_: &Value) -> Result<Value> {
    Ok(encoded(v2_capabilities(AGENT)))
}

/// `git_v2_request`: a request body → `{command: "ls-refs", symrefs, peel, prefixes}` or
/// `{command: "fetch", wants, haves, shallows, depth, deepen_relative, omit_blobs, done}`.
pub fn request(c: &Value) -> Result<Value> {
    Ok(match v2_request(&request_body(c)?)? {
        V2Command::LsRefs(r) => json!({
            "command": "ls-refs", "symrefs": r.symrefs, "peel": r.peel, "prefixes": r.prefixes,
        }),
        V2Command::Fetch(f) => json!({
            "command": "fetch", "wants": f.wants, "haves": f.haves, "shallows": f.shallows,
            "depth": f.depth, "deepen_relative": f.deepen_relative,
            "omit_blobs": f.omit_blobs, "done": f.done,
        }),
    })
}

/// `git_ls_refs`: `{refs: {name: id}, annotated: {name: tag id}, symrefs, peel, prefixes}`
/// → the answer: HEAD (main, when it exists) then branches and tags in name order, those
/// under any prefix (all without one). An annotated tag is listed as its tag object, with
/// `peeled:<commit>` when the client asked to peel.
pub fn ls_refs(c: &Value) -> Result<Value> {
    let prefixes: Vec<&str> = c["prefixes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let wanted = |name: &str| prefixes.is_empty() || prefixes.iter().any(|p| name.starts_with(p));
    let mut refs = Vec::new();
    for (name, id) in c["refs"].as_object().into_iter().flatten() {
        let listed = name.starts_with("refs/heads/") || name.starts_with("refs/tags/");
        if listed && wanted(name) {
            let commit = ObjectId::parse(id.as_str().unwrap_or_default())?;
            refs.push(match c["annotated"][name].as_str() {
                Some(tag) => (
                    name.clone(),
                    ObjectId::parse(tag)?,
                    (c["peel"] == true).then(|| format!("peeled:{commit}")),
                ),
                None => (name.clone(), commit, None),
            });
        }
    }
    refs.sort();
    if let Some(main) = c["refs"][MAIN].as_str()
        && wanted("HEAD")
    {
        let target = (c["symrefs"] == true).then(|| format!("symref-target:{MAIN}"));
        refs.insert(0, ("HEAD".into(), ObjectId::parse(main)?, target));
    }
    Ok(encoded(ls_refs_answer(&refs)))
}

/// `git_v2_fetch_head`: `{nak: true}` (a round with nothing in common), or
/// `{acknowledged: [id] | null, shallow_info, shallow, unshallow}` → what precedes the pack.
pub fn fetch_head(c: &Value) -> Result<Value> {
    if c["nak"] == true {
        return Ok(encoded(FetchHead::nak()));
    }
    let acknowledged = match c.get("acknowledged").filter(|v| !v.is_null()) {
        Some(_) => Some(id_list(c, "acknowledged")?),
        None => None,
    };
    let head = FetchHead {
        acknowledged,
        shallow_info: c["shallow_info"] == true,
        shallow: id_list(c, "shallow")?,
        unshallow: id_list(c, "unshallow")?,
    };
    Ok(encoded(head.encode()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use yoneda_core::git_object::{DELIM, FLUSH, pkt_line};

    fn text(answer: Value) -> String {
        String::from_utf8(
            STANDARD
                .decode(answer["body_b64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn parses_a_checkout_sized_request() {
        // A partial clone's checkout wants every file it lacks in one request.
        let mut body = [pkt_line(b"command=fetch\n"), DELIM.to_vec()].concat();
        for i in 0..12_000u32 {
            body.extend(pkt_line(format!("want {:040x}\n", i + 1).as_bytes()));
        }
        body.extend(pkt_line(b"done\n"));
        body.extend_from_slice(FLUSH);
        let parsed = request(&json!({ "body_b64": STANDARD.encode(body) })).unwrap();
        assert_eq!(parsed["wants"].as_array().unwrap().len(), 12_000);
    }

    #[test]
    fn lists_refs_by_prefix_with_head_as_main() {
        let (main, x) = ("a".repeat(40), "b".repeat(40));
        let refs = json!({ "refs/heads/main": main, "refs/heads/x": x, "refs/tags/v1": main,
                           "refs/yoneda/c/z": main });
        let all = text(
            ls_refs(&json!({ "refs": refs, "symrefs": true,
                             "prefixes": ["HEAD", "refs/heads/", "refs/tags/"] }))
            .unwrap(),
        );
        assert!(all.starts_with(&format!("0050{main} HEAD symref-target:refs/heads/main\n")));
        assert!(all.contains(&format!("{x} refs/heads/x\n")));
        assert!(all.contains(&format!("{main} refs/tags/v1\n")));
        assert!(!all.contains("refs/yoneda"));
        let heads = text(ls_refs(&json!({ "refs": refs, "prefixes": ["refs/heads/"] })).unwrap());
        assert!(!heads.contains("HEAD") && !heads.contains("refs/tags/"));
        // An annotated tag is its tag object, peeled to its commit when asked.
        let tag = "d".repeat(40);
        let annotated = json!({ "refs/tags/v1": tag });
        let peeled =
            text(ls_refs(&json!({ "refs": refs, "annotated": annotated, "peel": true })).unwrap());
        assert!(peeled.contains(&format!("{tag} refs/tags/v1 peeled:{main}\n")));
        let plain = text(ls_refs(&json!({ "refs": refs, "annotated": annotated })).unwrap());
        assert!(plain.contains(&format!("{tag} refs/tags/v1\n")));
        let empty = text(ls_refs(&json!({ "refs": {}, "symrefs": true })).unwrap());
        assert_eq!(empty, "0000");
    }

    #[test]
    fn parses_requests_and_frames_fetch_sections() {
        let want = "a".repeat(40);
        let body = [
            pkt_line(b"command=fetch\n"),
            DELIM.to_vec(),
            pkt_line(format!("want {want}\n").as_bytes()),
            pkt_line(b"deepen 1\n"),
            pkt_line(b"filter blob:none\n"),
            pkt_line(b"done\n"),
            FLUSH.to_vec(),
        ]
        .concat();
        let parsed = request(&json!({ "body_b64": STANDARD.encode(body) })).unwrap();
        assert_eq!(parsed["command"], "fetch");
        assert_eq!(parsed["wants"], json!([want]));
        assert_eq!(parsed["depth"], 1);
        assert_eq!(parsed["omit_blobs"], true);
        assert_eq!(parsed["shallows"], json!([]));
        assert!(text(capabilities(&json!({})).unwrap()).contains("fetch=shallow filter\n"));
        assert_eq!(
            text(fetch_head(&json!({ "nak": true })).unwrap()),
            "0014acknowledgments\n0008NAK\n0000"
        );
        let head = text(
            fetch_head(&json!({ "acknowledged": null, "shallow_info": true,
                                "shallow": [want], "unshallow": [] }))
            .unwrap(),
        );
        assert_eq!(
            head,
            format!("0011shallow-info\n0035shallow {want}\n0001000dpackfile\n")
        );
    }
}
