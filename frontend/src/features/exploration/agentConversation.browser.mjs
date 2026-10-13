// Real served frontend with synthetic offline conversation API pages; no provider calls.
// biome-ignore lint/correctness/noUnusedVariables: Playwright consumes this file as a function.
async function verifyAgentConversation(page) {
  const origin = 'http://127.0.0.1:5179';
  const fixture = await (
    await page.request.get(`${origin}/src/features/exploration/reviewBrowserFixture.json`)
  ).json();
  const { repo, run, snapshot } = fixture;
  const reads = [];
  const writes = [];
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on('pageerror', onError);
  snapshot.team_tasks = [{ run_id: run.id, task_id: 'calendar-task', title: 'Calendar behavior' }];
  const message = {
    id: 'message',
    seq: 7,
    run_id: run.id,
    sender: 'agent',
    recipient: 'calendar-task',
    kind: 'contract',
    body: 'Keep calendarEvents IDs stable. I will preserve anonymous access.',
    context_ids: ['prior-constraint'],
    authority: 'assertion',
    delivery_receipts: {
      delivered: 2,
      acknowledged: 1,
      proves: 'delivery and acknowledgement, not understanding',
    },
  };
  await page.route(`${origin}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (request.method() !== 'GET') {
      writes.push(path);
      return reply({ error: { message: 'Offline mutation rejected' } }, 409);
    }
    if (path === '/api/repositories')
      return reply({
        repositories: [repo],
        identity: { role: 'user', username: 'offline', reviewer: false },
      });
    if (path.endsWith('/overview'))
      return reply({ repository: repo, capabilities: {}, counts: {}, watermark: 10 });
    if (path.endsWith('/runs'))
      return reply({ items: [run], watermark: 10, has_more: false, next_cursor: null });
    if (path.endsWith(`/runs/${run.id}`)) return reply(snapshot);
    if (path.endsWith('/events')) return reply({ events: [] });
    if (path.endsWith('/peer_messages_page')) {
      reads.push(url.search);
      if (url.searchParams.get('after') === '0')
        return reply({ items: [message], has_more: true, next_cursor: 7, watermark: 19 });
      if (url.searchParams.get('watermark') !== '19')
        throw new Error('Pagination lost its fixed watermark');
      return reply({
        items: [
          {
            ...message,
            id: 'message-next',
            seq: 12,
            kind: 'finding',
            body: 'The accented-name regression passes.',
          },
        ],
        has_more: false,
        next_cursor: 12,
        watermark: 19,
      });
    }
    throw new Error(`Unexpected fixture read: ${path}`);
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/?repo=${repo.id}&run=${run.id}`);
    await page.getByRole('heading', { name: 'Outcome preview', exact: true }).waitFor();
    if (reads.length) throw new Error('Conversation loaded before inspection');
    await page.getByRole('tab', { name: 'Agent activity', exact: true }).click();
    if (reads.length) throw new Error('Conversation loaded before explicit inspection');
    await page
      .getByRole('button', { name: 'Show agent conversation', exact: true })
      .click({ timeout: 3000 });
    const conversation = page.getByRole('region', { name: 'Agent conversation', exact: true });
    await conversation.getByText(message.body, { exact: true }).waitFor();
    await conversation
      .getByText('Calendar maintenance → Calendar behavior', { exact: true })
      .waitFor();
    await conversation.getByText('2 deliveries · 1 acknowledgement', { exact: true }).waitFor();
    await conversation
      .getByText('Delivery and acknowledgement do not prove understanding or agreement.', {
        exact: false,
      })
      .waitFor();
    await conversation.getByRole('button', { name: 'Load next messages', exact: true }).click();
    await conversation.getByText('The accented-name regression passes.', { exact: true }).waitFor();
    if (await conversation.getByRole('button', { name: 'Load next messages', exact: true }).count())
      throw new Error('Exhausted page offered continuation');
    if (reads.length !== 2 || !reads[1].includes('after=7') || !reads[1].includes('watermark=19'))
      throw new Error('Page cursor or watermark incorrect');
    if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)))
      throw new Error('Conversation overflows mobile');
    if (writes.length || errors.length) throw new Error('Unexpected mutation or browser exception');
    return {
      passed: 4,
      evidence: 'Real served frontend; synthetic offline API pages',
      reads: reads.length,
      mutations: 0,
      pageErrors: 0,
      scenarios: [
        'explicit lazy inspection',
        'actual message bodies and named participants',
        'honest delivery receipts',
        'stable watermark pagination and mobile width',
      ],
    };
  } catch (failure) {
    throw new Error(
      `${failure.message}; page errors: ${errors.join('; ')}; fixture UI: ${await page.locator('body').innerText()}`,
    );
  } finally {
    page.off('pageerror', onError);
    await page.unroute(`${origin}/api/**`);
    await page.goto('about:blank');
  }
}
