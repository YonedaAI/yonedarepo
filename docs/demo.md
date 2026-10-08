# Log in and try YonedaRepo

Open [the development website](https://yonedarepo-dev.mlong-f01.workers.dev). The sidebar's **Demo guide** explains both flows below inside the app.

## Log in

This development workspace uses an owner token, rather than a username/password account. You do not log in with your Claude or OpenAI key.

1. Click **Connect workspace**, or **Owner connection** in the bottom-left sidebar. If Retry client is already visible, you are connected and can skip these steps.
2. Choose the file under **Or connect with your owner token file**.
3. On this development Mac, the file is `/Users/mlong/Documents/Development/yonedarepo/.local/owner-token`. In the macOS file picker, press **Command-Shift-G**, enter that full path, press Return, then choose **Open**. The `.local` folder is hidden in ordinary browsing.
4. The app connects automatically after the file is chosen. Expect **Retry client** in the sidebar. If it does not open automatically, click it.

The token is private. Do not post it in chat, commit it, or use a provider API key in its place. The file-picker flow avoids displaying its value. If the session expires, reconnect with the same file. **Owner connection → Disconnect** signs out.

## Five-minute demo using existing results

This does not start inference or change published code. No terminal commands or new agent run are needed.

| Action | Expected result / what you are checking |
| --- | --- |
| Open **Retry client → Exploration**. | **New run** is the primary action. **Run history** opens earlier real attempts. The accepted run shows research → coding → capture → checks → decision → publication, with recorded results. |
| Open **Read shared research**, then **Compare changes**. | Read the agent-authored artifact and compare two captured implementations beside each other, with added/removed lines highlighted. |
| Expand **Review changes** for each candidate. | You can compare actual source changes and understand the tradeoff. **Select approach** is disabled because this run was already accepted. |
| Open **Intentional history**. Keep the default published **Commit** and **Path** `src/main.rs`; click **Trace history**. | The graph shows context recorded for that exact source revision. Click **Fit View** if needed. |
| Click execution, research, evaluation, candidate and decision nodes. | The evidence panel shows agent context, checks, alternatives and selection rationale. Completed execution nodes should show `completed` in **Record details**. |
| Find the observation labelled `upstream_p99_ms: 350`. | Its details say `simulated: true`, with limit 100. Its connection leads to the original research assumption, which remains preserved. |
| Refresh the page and repeat Trace history. | The published revision and recorded history persist. |

The existing selection is labelled **development_verification**: it was an automated fixture check, not your approval. The incident is simulated, not a production outage.

For initial feedback, only check whether these steps are understandable, the diff/checks are readable, and you can find why the published code was chosen. Report the step and unexpected behavior if anything is unclear. You do not need to inspect infrastructure or run the Rust test suite.

## Optional: exercise a fresh decision

This launches real paid Sonnet/Luna inference and publishes a new demo revision if you choose a candidate. Do this after the browsing demo if you want to test the complete interaction yourself.

1. In **Exploration**, click **New run**. Leave the sample intent: “Add safe retries for transient upstream failures within a bounded total deadline.” Review the fixture scope and required behavior, then click **Start run** once. Opening the form alone launches nothing.
2. Expect research first, then three coding executions. Agents provide research and assumptions; you do not type the context manually. Allow several minutes for containers, inference, capture and independent checks. Terminal errors should remain visible rather than appearing as success.
3. When candidates have checks, expand **Review changes** and compare. Only **eligible** candidates on the current base can be selected. A rejected candidate is a verification result, not something to bypass.
4. Click **Select approach** on an eligible candidate. Enter your own tradeoff under **Why choose this approach?**, then click **Record decision and publish**. **Keep comparing** dismisses the selection without publishing.
5. While publication is pending, the banner distinguishes the selected commit from the previous published commit. After verified publication, expect the header's **Published** commit to match the candidate, the repository version to increase, and the pending banner to disappear. The transition can be too quick to see.
6. Open **Intentional history** after publication. Use the new Published commit and `src/main.rs`, then click **Trace history**. Find your rationale and the alternatives you considered.
7. Optional: under **Challenge an assumption**, choose the new research's latency assumption and enter a value above its stated limit. Click **Record simulated observation**. Expect an exceeded observation linked to the unchanged original assumption. This adds test history but does not launch models.

If nothing is eligible, stop at the failed checks; do not record a decision. **Cancel run** stops an unfinished exploration. If publication is blocked, retain the visible selected/published split and follow the recovery instructions in [the runbook](runbook.md).

## Developer verification

`cargo xtask check` is the keyless local gate. `cargo xtask verify-live --url https://yonedarepo-dev.mlong-f01.workers.dev` reads the existing live evidence and starts no inference. These establish automated behavior; the walkthrough above is for judging the product experience.
