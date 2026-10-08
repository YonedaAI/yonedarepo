# Build, compare and publish a website

Open the platform and create a username/password account. Save the one-time recovery code privately. No owner token is required for a personal workspace.

1. Open **Agent providers**. Connect a MiMo, ZAI, OpenAI or Anthropic API key and choose its configured model. Keys are encrypted on the server and never returned to the browser. See [provider settings and cost controls](providers.md).
2. Choose **Add repository**. Start with the website template or import a public GitHub, GitLab, Codeberg or Bitbucket HTTPS repository. Provisioning and failures appear in the workspace; retry preserves the repository identity.
3. Choose **New run**. Write the brief and acceptance criteria, choose two provider/approach combinations, and optionally select prior context. Two approaches may use the same provider.
4. Inspect **Build and independent check commands**. This is your approved policy, frozen into the run. The starter's check only confirms an HTML entrypoint, title and viewport; add meaningful project tests. Setup and checks are bounded to 90 seconds total. The fixed runtime supports Node 24, Rust 1.94 and Python's standard library; package downloads are restricted to public npm and Cargo registries.
5. Approve the brief. Agents work concurrently from the same source revision and context. Their findings, assumptions, alternatives and questions appear in the typed graph. Context is an assertion until independently checked or adopted by a human decision.
6. The workflow shows **Ready for review** when checked source is eligible against the current base and policy. Compare captured Git revisions, source diffs, independent check results and checked website previews. A preview link is a one-hour bearer capability; anyone you share it with can view those assets during that hour.
7. Select an eligible approach. Record why it should ship and why the alternatives were retained or rejected. Selection reserves publication. The publisher checks ancestry, uses an expected-old Git lease and reads back the canonical commit.
8. Open the published website. Its serving pointer advances only after verified Git publication. A publication conflict leaves the previous site serving. The displayed hosted revision may therefore differ from a selected revision or later source-only publication.

Static output must contain `index.html` in the approved `static_dir`, at most 500 regular files and 8 MiB decoded content. Symlinks and unsafe paths fail capture. Use relative asset URLs; for Vite, set `base: './'`. Sites are served on a separate Worker origin with an opaque browser sandbox and no platform credentials. Arbitrary external API calls, service workers and server-side application hosting are outside this static profile.

Use **Context graph** search and type filters to find prior assertions, then expand a selected record's relationships. **Intentional history** traces an exact source revision/path to the decision, alternatives and evidence. A follow-up run can select previous records in its brief, preserving the context it actually received.

The workflow engine owns scheduling, capture, evaluation and publication. Agents supply code and typed context; their completion signal requests capture, rather than approval. The owner makes the shipping decision in the website. External MCP credentials deliberately have no selection or publication tool. Typed questions are currently recorded context: an interactive clarification request that pauses and resumes an attempt is a future workflow capability, not implemented by chat prompts outside the product.

# Local operation

`cargo xtask setup` creates private local authentication and vault keys. `cargo xtask dev` runs the platform at `http://localhost:8787` and the sites Worker at `http://localhost:8788`. Local Durable Objects, D1 and R2 use `.wrangler/state`; Artifacts uses the configured remote development namespace and requires Cloudflare authentication. Hosted inference is paid when you approve a run; `cargo xtask check` launches none.

After deployment, run `cargo xtask seed-template --url URL` once as the platform operator. It creates the small Artifacts starter using a short-lived Git capability and revokes that capability. Personal project creation then forks the starter through the browser. This operator bootstrap is separate from user onboarding.

Cloudflare supports separate dev commands when [each Worker needs its own local URL](https://developers.cloudflare.com/workers/local-development/multi-workers/). The developer command manages both processes. Source tests and local browser checks do not establish successful deployed inference, Artifacts capture, publication or hosting; those are recorded separately in the release evidence.
