// Run with browser_run_code_unsafe(filename) against the frontend Vite server (port 5186).
// Serves the real app with synthetic API fixtures; never calls providers.
// Regression: owner mutations without a follow-up (Retry task, Cancel run) sent no request.
async (page) => {
  const origin = 'http://127.0.0.1:5186';
  const repo = {
    id: 'team-retry-browser', name: 'Team retry sandbox', status: 'ready',
    published_commit: 'a'.repeat(40), head_commit: 'a'.repeat(40),
    version: 3, pending: null, policy: {},
  };
  const capabilities = { collaborative_runs: 1, team_planning: 1 };
  const run = {
    id: 'run-team-1', intent: 'Build the laundry order flow.', mode: 'collaborate',
    status: 'running', criteria: [], context: [], agents: [], team_plan_revision: 1,
    team_plan: { tasks: [{ id: 'laundry-order-frontend' }] }, created_at: '2026-10-21T00:00:00Z',
  };
  const task = {
    id: 'run-team-1:laundry-order-frontend', run_id: run.id, task_id: 'laundry-order-frontend',
    title: 'Laundry order frontend', role: 'specialist', status: 'failed', epoch: 4, revision: 2,
    depends_on: [], write_paths: ['frontend/'], instructions: 'Build the order form.',
    error: 'Checks failed',
  };
  const detail = {
    repository: repo, runs: [run], executions: [], candidates: [], evaluations: [], decisions: [],
    artifacts: [], nodes: [], edges: [], graph_paged: true, team_tasks: [task], team_handoffs: [],
  };
  let failRetry = false;
  const mutations = [];
  const errors = [];
  const onPageError = (error) => errors.push(error.message);
  page.on('pageerror', onPageError);
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const respond = (route, json, status = 200) => route.fulfill({ status, json });
  await page.route(`${origin}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === 'POST') {
      mutations.push({ path, body: request.postDataJSON() });
      if (path === `/api/repos/${repo.id}/retry_team_task` && failRetry)
        return respond(route, { error: { code: 'STALE_TASK', message: 'Simulated stale task revision' } }, 409);
      if ([`/api/repos/${repo.id}/retry_team_task`, `/api/repos/${repo.id}/cancel_run`].includes(path))
        return respond(route, { ok: true });
      return respond(route, { error: { code: 'NOT_FOUND', message: `Unexpected mutation ${path}` } }, 404);
    }
    if (path === '/api/repositories')
      return respond(route, { repositories: [repo], identity: { role: 'user', username: 'owner' } });
    if (path === `/api/repos/${repo.id}/overview`)
      return respond(route, { repository: repo, watermark: 1, capabilities, working_branches: [] });
    if (path === `/api/repos/${repo.id}/runs`) return respond(route, { items: [{ id: run.id }] });
    if (path === `/api/repos/${repo.id}/runs/${run.id}`) return respond(route, detail);
    // Other evidence reads (events, logs) are optional for this flow.
    return respond(route, { error: { code: 'NOT_FOUND', message: 'Not in fixture' } }, 404);
  });
  await page.routeWebSocket(/\/api\/repos\/.*\/live/, () => {});
  try {
    await page.goto(origin);
    await page.getByRole('tab', { name: 'Agent activity' }).click();
    const retry = page.getByRole('button', { name: 'Retry task', exact: true });
    await retry.waitFor();
    assert(await retry.isEnabled(), 'Retry task must be enabled for a failed task');
    await retry.click();
    await page.waitForTimeout(500);
    const retries = mutations.filter((item) => item.path.endsWith('/retry_team_task'));
    assert(retries.length === 1, `Retry task must POST once, saw ${retries.length}`);
    assert(
      JSON.stringify(retries[0].body) ===
        JSON.stringify({ run_id: run.id, task_id: task.task_id, expected_epoch: 4, expected_revision: 2 }),
      `Unexpected retry body ${JSON.stringify(retries[0].body)}`,
    );

    mutations.length = 0;
    await page.getByRole('button', { name: 'Cancel run', exact: true }).first().click();
    const confirm = page.getByRole('button', { name: 'Confirm cancel run', exact: true });
    if (await confirm.count()) await confirm.click();
    await page.waitForTimeout(500);
    const cancels = mutations.filter((item) => item.path.endsWith('/cancel_run'));
    assert(cancels.length === 1, `Cancel run must POST once, saw ${cancels.length}`);
    assert(cancels[0].body.run_id === run.id, 'Cancel run must name the run');

    mutations.length = 0;
    failRetry = true;
    await retry.click();
    await page.getByRole('alert').filter({ hasText: 'Simulated stale task revision' }).waitFor();
    assert(mutations.length === 1, 'A refused retry is sent once and never retried silently');
    assert(errors.length === 0, `Browser exceptions: ${errors.join('; ')}`);
    return { passed: 3, scenarios: ['retry task posts', 'cancel run posts', 'refused retry shows alert'] };
  } finally {
    page.off('pageerror', onPageError);
    await page.unroute(`${origin}/api/**`);
    await page.goto('about:blank');
  }
}
