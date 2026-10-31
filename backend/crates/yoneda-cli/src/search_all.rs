//! `yoneda search <query> --all`: a search across the account's repositories, on the account
//! API. The platform chooses which repositories to ask; this prints what they found.
use crate::error::{Error, Result};
use crate::human;
use crate::output::{self, SearchAll, SearchAllFailed, SearchAllRepo};
use crate::reads::{print_search, query};
use crate::target;
use serde_json::Value;

pub struct Asked {
    pub query: String,
    pub groups: Option<Vec<String>>,
    pub limit: Option<u64>,
    pub word: bool,
    pub after: Option<String>,
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

/// What `found` (one repository's entry) prints and reports.
fn repository(found: &Value, query: &Value) -> Result<SearchAllRepo> {
    let repo = text(&found["repo"]);
    let name = text(&found["name"]);
    let mut answer = found["answer"].clone();
    answer["query"] = query.clone();
    human!("{}", found["path"].as_str().unwrap_or(&name));
    let search = print_search(&answer)?;
    Ok(SearchAllRepo {
        repo,
        name,
        path: found["path"].as_str().map(str::to_owned),
        search,
    })
}

pub async fn run(origin: Option<&str>, asked: Asked) -> Result<()> {
    let (_, api) = target::account_api(origin)?;
    let q = query(&[
        ("query", Some(asked.query)),
        ("groups", asked.groups.map(|g| g.join(","))),
        ("limit", asked.limit.map(|l| l.to_string())),
        ("word", asked.word.then(|| "true".to_owned())),
        ("after", asked.after),
    ]);
    let page = api.get(&format!("/search{q}")).await.map_err(|failure| {
        let error = Error::from(failure);
        match error.platform_code.as_deref() {
            Some("NOT_FOUND") => Error::new(
                "This platform doesn't search across repositories yet: use yoneda search in one",
            ),
            _ => error,
        }
    })?;
    let list = |key: &str| page[key].as_array().cloned().unwrap_or_default();
    let repos = list("results")
        .iter()
        .map(|found| repository(found, &page["query"]))
        .collect::<Result<Vec<_>>>()?;
    let failed: Vec<SearchAllFailed> = list("failed")
        .iter()
        .map(|f| SearchAllFailed {
            repo: text(&f["repo"]),
            name: text(&f["name"]),
            error: text(&f["error"]),
        })
        .collect();
    for f in &failed {
        human!("couldn't search {}: {}", f.name, f.error);
    }
    let (searched, scanned) = (
        page["searched"].as_u64().unwrap_or_default(),
        page["scanned"].as_u64().unwrap_or_default(),
    );
    let next = page["next"].as_str().map(str::to_owned);
    human!(
        "found in {} of {searched} repositories searched",
        repos.len()
    );
    if let Some(next) = &next {
        human!("more: --after {next}");
    }
    output::emit(&SearchAll {
        query: text(&page["query"]),
        repos,
        failed,
        searched,
        scanned,
        next,
    });
    Ok(())
}
