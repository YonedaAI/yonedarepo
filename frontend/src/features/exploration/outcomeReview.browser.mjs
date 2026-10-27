// Offline API fixtures around the real served application. No provider calls or publication.
// Run with browser_run_code_unsafe(filename) against the frontend Vite server on port 5179.
// biome-ignore lint/correctness/noUnusedVariables: Playwright consumes this file as a function.
async function verifyOutcomeReview(page) {
  const origin = 'http://127.0.0.1:5179';
  const assert = (value, message) => {
    if (!value) throw new Error(message);
  };
  const errors = [];
  const writes = [];
  const unexpected = [];
  const onError = (error) => errors.push(error.message);
  page.on('pageerror', onError);
  const reviewer = false;
  const fixtureResponse = await page.request.get(
    `${origin}/src/features/exploration/reviewBrowserFixture.json`,
  );
  const { repo, constraint, linked, run, execution, candidate, snapshot } =
    await fixtureResponse.json();
  let failUsage = true;
  let releaseUsage;
  let usageGate;
  await page.route(`${origin}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (request.method() !== 'GET') {
      writes.push(path);
      return reply({ error: { message: 'Offline fixture rejects every mutation' } }, 409);
    }
    if (path === '/api/repositories')
      return reply({
        repositories: [repo],
        identity: { role: 'user', username: 'offline', reviewer },
      });
    if (path.endsWith('/overview'))
      return reply({
        repository: repo,
        watermark: 10,
        capabilities: snapshot.capabilities,
        working_branches: snapshot.working_branches ?? [],
        counts: {},
      });
    if (path.endsWith('/runs'))
      return reply({ items: [run], watermark: 10, has_more: false, next_cursor: null });
    if (path.endsWith(`/runs/${run.id}`)) return reply(snapshot);
    if (path.endsWith('/context_usage')) {
      if (usageGate) await usageGate;
      return failUsage
        ? reply({ error: { message: 'Simulated retrieval failure' } }, 503)
        : reply({
            version: 1,
            run_id: run.id,
            coverage: { status: 'partial', reason: 'Offline fixture access page', activated_at: 0 },
            counts: { assigned: 1, returned: 0, opened: 0, cited: 0, checked: 0, read_calls: 0 },
            assigned: [],
            entries: [],
            citations: [],
            checked: [],
            citations_truncated: false,
            next_cursor: 0,
            has_more: false,
          });
    }
    if (path.endsWith('/context_get')) return reply(linked);
    if (path === '/api/settings') return reply({ providers: [] });
    if (path.endsWith('/site_preview')) return reply({ url: `${origin}/#offline-app-preview` });
    if (path.endsWith('/run_graph_page'))
      return reply({
        nodes: [constraint],
        edges: [],
        run_id: run.id,
        watermark: 10,
        has_more: false,
        next_cursor: null,
      });
    unexpected.push(path);
    return reply({ error: { message: 'Unexpected offline fixture read' } }, 404);
  });
  try {
    await page.setViewportSize({ width: 1365, height: 900 });
    await page.goto(`${origin}/?repo=${repo.id}&run=${run.id}`);
    await page.getByRole('heading', { name: 'Outcome preview', exact: true }).waitFor();
    assert(
      (await page
        .getByRole('tab', { name: 'Results', exact: true })
        .getAttribute('aria-selected')) === 'true',
      'Default review must show outcomes',
    );
    await page.getByRole('button', { name: 'Review result', exact: true }).click();
    assert((await page.getByRole('dialog').count()) === 0, 'Review banner must inspect results');
    await page
      .locator('.outcome-preview')
      .getByRole('button', { name: 'Preview website', exact: true })
      .click();
    await page.getByRole('link', { name: 'Open checked preview (valid for 1 hour)' }).waitFor();
    await page.getByRole('button', { name: 'Record publishing decision', exact: true }).click();
    await page.getByRole('dialog', { name: 'Record publishing decision' }).waitFor();
    await page.keyboard.press('Escape');
    assert(
      (await page.getByRole('dialog').count()) === 0,
      'Publishing dialog must close on Escape',
    );
    await page.getByText('Review changes', { exact: true }).click();
    await page.getByRole('region', { name: 'Changes in calendar.mjs' }).waitFor();
    await page.getByRole('button', { name: 'Next file', exact: true }).click();
    assert(
      await page
        .getByRole('region', { name: 'Changes in tests/calendar.mjs' })
        .innerText()
        .then((text) => text.includes('assertSearch')),
      'Second file patch must be readable',
    );
    usageGate = new Promise((resolve) => {
      releaseUsage = resolve;
    });
    await page
      .getByRole('button', { name: 'Read prior context and citations', exact: true })
      .click();
    await page.getByText(constraint.data.statement, { exact: true }).waitFor();
    assert(
      (await page
        .getByRole('status')
        .filter({ hasText: 'Loading recorded context evidence' })
        .count()) === 1,
      'Frozen statement must remain readable while receipts load',
    );
    releaseUsage();
    usageGate = undefined;
    await page.getByRole('alert').filter({ hasText: 'Simulated retrieval failure' }).waitFor();
    assert(
      (await page.getByText(constraint.data.statement, { exact: true }).count()) === 1,
      'Frozen context must survive retrieval error',
    );
    failUsage = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByText('Not shown on this page', { exact: true }).waitFor();
    await page.getByText('Read linked record: linked-contract', { exact: true }).click();
    await page.getByText(linked.data.statement, { exact: true }).waitFor();
    assert(
      (await page.getByText('Current linked record;', { exact: false }).count()) === 1,
      'Linked record must remain distinct from frozen input',
    );
    await page.getByRole('tab', { name: 'Results', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect evidence graph', exact: true }).click();
    await page.getByRole('button', { name: 'Explore graph', exact: true }).click();
    await page.locator('.graph-canvas').waitFor();
    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('heading', { name: 'Outcome preview', exact: true }).waitFor();
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Mobile review must not overflow horizontally',
    );
    snapshot.working_branches = [
      {
        id: 'development',
        status: 'active',
        version: 2,
        working_commit: candidate.revision.commit,
        working_revision: candidate.revision,
        canonical_base_commit: repo.published_commit,
        canonical_base_version: repo.version,
        latest_candidate_id: candidate.id,
      },
    ];
    snapshot.capabilities.working_branches = 1;
    run.working_branch_id = 'development';
    snapshot.runs = [run];
    await page.reload();
    await page.getByRole('heading', { name: 'Checked working branch', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Continue checked work', exact: true }).click();
    const brief = page.getByRole('dialog', { name: 'Continue working branch' });
    await brief.waitFor();
    await brief.getByRole('form', { name: 'Approve run brief' }).waitFor();
    assert(
      (await brief.locator('textarea').first().inputValue()) === '',
      'Continuation must request new intent rather than silently repeat previous work',
    );
    assert(
      (await brief.innerText()).includes('working revision, version 2'),
      'Continuation must preserve the checked working lease',
    );
    assert(
      (await brief.innerText()).includes('Canonical source remains'),
      'Continuation must keep canonical publication separate',
    );
    await page.keyboard.press('Escape');
    run.status = 'coordinating';
    run.autonomy_policy = {
      version: 1,
      enabled: true,
      max_repair_rounds: 2,
      max_concurrent_agents: 3,
      max_executions: 20,
      source_scope: 'project',
      allow_intent_questions: true,
    };
    snapshot.executions = ['Access contract', 'Calendar behavior', 'App integration'].map(
      (strategy, index) => ({ ...execution, id: `ongoing-${index}`, strategy, status: 'running' }),
    );
    snapshot.candidates = [];
    snapshot.evaluations = [];
    await page.reload();
    const agents = page.getByRole('region', { name: 'Agent work', exact: true });
    await agents.getByRole('heading', { name: 'Frozen work approval', exact: true }).waitFor();
    assert((await agents.locator('li').count()) === 3, 'All three ongoing agents must be visible');
    assert(
      (await agents.getByText('Working', { exact: true }).count()) === 3,
      'All three active agents must show Working',
    );
    const approval = await agents.innerText();
    for (const bound of [
      '3 agents concurrently',
      '20 executions total',
      '2 repair rounds',
      'Publication requires a separate owner decision.',
    ])
      assert(approval.includes(bound), `Frozen approval missing ${bound}`);
    assert(
      await page.getByRole('button', { name: 'Continue checked work', exact: true }).isDisabled(),
      'Active coordination must block overlapping continuation',
    );
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Ongoing agent review must fit the mobile viewport',
    );
    assert(writes.length === 0, `Unexpected writes: ${writes.join(', ')}`);
    assert(unexpected.length === 0, `Unexpected reads: ${unexpected.join(', ')}`);
    assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return {
      passed: 12,
      evidence: 'Real served frontend; synthetic offline API fixtures',
      viewport: '1365x900 and 390x844',
      mutations: writes.length,
      pageErrors: errors.length,
      scenarios: [
        'outcome default',
        'review banner inspection',
        'checked app preview',
        'explicit publishing dialog',
        'multi-file patch navigation',
        'frozen context while loading/error',
        'safe evidence retry and linked statement',
        'graph drilldown',
        'mobile width',
        'checked branch continuation with separate canonical source',
        'three ongoing agents and finite frozen approval',
      ],
    };
  } finally {
    if (releaseUsage) releaseUsage();
    page.off('pageerror', onError);
    await page.unroute(`${origin}/api/**`);
    await page.goto('about:blank');
  }
}
