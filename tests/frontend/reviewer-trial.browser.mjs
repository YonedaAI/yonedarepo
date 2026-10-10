// Run with browser_run_code_unsafe(filename) against the frontend Vite server.
// Serves the real app with synthetic API fixtures; never calls providers.
async (page) => {
  const origin = 'http://127.0.0.1:5186';
  const repo = {
    id: 'reviewer-browser', name: 'Reviewer sandbox', status: 'ready',
    published_commit: 'a'.repeat(40), head_commit: 'a'.repeat(40),
    version: 0, pending: null, policy: {},
  };
  const snapshot = {
    v: 1, seq: 1, repository: repo, runs: [], executions: [], team_tasks: [],
    team_handoffs: [], candidates: [], evaluations: [], decisions: [],
    artifacts: [], nodes: [], edges: [], capabilities: {},
  };
  let activeTrial = 'reviewer-pending-browser-12345678';
  let failStatus = false;
  let statusGate;
  let resumeGate;
  const mutations = [];
  const errors = [];
  const onPageError = (error) => errors.push(error.message);
  page.on('pageerror', onPageError);
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const respond = (route, json, status = 200) => route.fulfill({ status, json });
  await page.route(`${origin}/api/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      mutations.push({ path, body: request.postDataJSON() });
      if (path === '/api/reviewer/trial') {
        activeTrial = `reviewer-${request.postDataJSON().request_id}`;
        return respond(route, { error: { code: 'REQUEST_FAILED', message: 'Simulated start failure' } }, 409);
      }
      if (path === '/api/reviewer/resume') {
        if (resumeGate) await resumeGate;
        return respond(route, { repo_id: repo.id, run_id: activeTrial });
      }
      throw new Error(`Unexpected mutation: ${path}`);
    }
    if (path === '/api/repositories')
      return respond(route, { repositories: [repo], identity: { role: 'user', username: 'reviewer', reviewer: true } });
    if (path === `/api/repos/${repo.id}/snapshot`) return respond(route, snapshot);
    if (path === '/api/reviewer') {
      if (statusGate) await statusGate;
      if (failStatus) return respond(route, { error: { code: 'REQUEST_FAILED', message: 'Trial status unavailable' } }, 409);
      return respond(route, { active_trial: activeTrial, budget: { limit: 50_000_000, charged: 0 } });
    }
    throw new Error(`Unexpected API read: ${path}`);
  });
  try {
    let releaseStatus;
    statusGate = new Promise(resolve => { releaseStatus = resolve; });
    await page.goto(origin);
    const loading = page.getByRole('button', { name: 'Loading trial…', exact: true });
    await loading.waitFor();
    assert(await loading.isDisabled(), 'Mutation must be disabled until durable trial status loads');
    releaseStatus();
    statusGate = undefined;
    const resume = page.getByRole('button', { name: 'Resume trial', exact: true });
    await resume.waitFor();
    assert(mutations.length === 0, 'Loading an active trial must not start work');
    let releaseResume;
    resumeGate = new Promise(resolve => { releaseResume = resolve; });
    await resume.focus();
    await page.keyboard.press('Enter');
    const resuming = page.getByRole('button', { name: 'Resuming…', exact: true });
    await resuming.waitFor();
    assert(await resuming.isDisabled(), 'Resume must be disabled while in flight');
    assert(mutations.length === 1 && mutations[0].path === '/api/reviewer/resume', 'Active trial must use resume endpoint');
    assert(JSON.stringify(mutations[0].body) === '{}', 'Resume identity must come from server');
    releaseResume();
    resumeGate = undefined;
    await resume.waitFor();

    mutations.length = 0;
    activeTrial = null;
    await page.reload();
    const start = page.getByRole('button', { name: 'Run prepared example', exact: true });
    await start.waitFor();
    await start.click();
    await page.getByRole('alert').filter({ hasText: 'Simulated start failure' }).waitFor();
    await resume.waitFor();
    assert(mutations.length === 1 && mutations[0].path === '/api/reviewer/trial', 'Fresh trial should start once');
    const reserved = activeTrial;
    assert(reserved === `reviewer-${mutations[0].body.request_id}`, 'Failed start must retain its server reservation');
    await page.reload();
    await resume.waitFor();
    await resume.click();
    await page.waitForResponse(response => response.url().endsWith('/api/reviewer') && response.status() === 200);
    assert(mutations.length === 2 && mutations[1].path === '/api/reviewer/resume', 'Reload must resume instead of generating another trial');
    assert(activeTrial === reserved, 'Reload and resume must preserve exact active ID');

    failStatus = true;
    await page.reload();
    const retry = page.getByRole('button', { name: 'Retry trial status', exact: true });
    await retry.waitFor();
    await page.getByRole('alert').filter({ hasText: 'Trial status unavailable' }).waitFor();
    const before = mutations.length;
    failStatus = false;
    await retry.click();
    await resume.waitFor();
    assert(mutations.length === before, 'Retrying status must never start a new trial');
    assert(await page.getByRole('alert').count() === 0, 'Successful status retry should clear the error');
    assert(errors.length === 0, `Browser exceptions: ${errors.join('; ')}`);
    return { passed: 3, scenarios: ['loading and keyboard resume', 'failed start then reload resumes exact ID', 'status error and safe retry'] };
  } finally {
    page.off('pageerror', onPageError);
    await page.unroute(`${origin}/api/**`);
    await page.goto('about:blank');
  }
}
