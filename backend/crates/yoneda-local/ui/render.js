const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
let data;
const actor = (name) =>
  name === 'user:local' ? 'Local user' : name.replace(/^token:/, '').replace(/^system:/, '');
const label = (name) =>
  ({
    passed: 'Passed',
    failed: 'Failed',
    running: 'Running',
    pending: 'Pending',
    queued: 'Queued',
    not_run: 'Not run',
  })[name] ?? 'Not run';
export async function copy(value) {
  try {
    await navigator.clipboard.writeText(value);
    $('announcement').textContent = 'Copied to clipboard.';
  } catch {
    $('announcement').textContent = 'Could not copy. Select the text and copy it.';
  }
}
function hashButton(commit) {
  const button = node('button', commit.slice(0, 8), 'hash');
  button.type = 'button';
  button.title = `Copy commit ${commit}`;
  button.setAttribute('aria-label', `Copy commit ${commit.slice(0, 8)}`);
  button.addEventListener('click', () => copy(commit));
  return button;
}
function time(at) {
  const element = node(
    'time',
    at ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '',
  );
  if (at) {
    element.dateTime = new Date(at).toISOString();
    element.title = new Date(at).toLocaleString();
  }
  return element;
}
function empty(parent, title, message) {
  const box = node('div', undefined, 'empty');
  box.append(node('h3', title), node('p', message));
  parent.append(box);
}
function renderLandings() {
  const list = $('landings');
  list.replaceChildren();
  if (!data.landings.length) {
    empty(list, 'No landings yet', 'Accepted changes from your worktrees appear here.');
    return;
  }
  for (const item of data.landings) {
    const row = node('div', undefined, 'landing');
    const main = node('div', undefined, 'landing-main');
    const title = node('div', undefined, 'landing-title');
    title.append(
      node('span', item.merged ? 'Merged' : 'Accepted', 'badge'),
      node('span', item.message),
    );
    title.title = item.message;
    main.append(title, node('div', actor(item.actor), 'landing-meta'));
    row.append(main, hashButton(item.commit), time(item.at_ms));
    list.append(row);
  }
}
function renderRefusals() {
  const list = $('refusals');
  list.replaceChildren();
  if (!data.refusals.length) {
    empty(list, 'No refused pushes', 'Pushes that need attention appear here.');
    return;
  }
  for (const item of data.refusals) {
    const row = node('div', undefined, 'landing');
    const main = node('div', undefined, 'landing-main');
    const title = node('div', undefined, 'landing-title');
    title.append(node('span', 'Refused', 'badge refused'), node('span', item.reason));
    title.title = item.reason;
    main.append(title, node('div', `${actor(item.actor)} on ${item.branch}`, 'landing-meta'));
    row.append(main, item.commit ? hashButton(item.commit) : node('span', ''), time(item.at_ms));
    list.append(row);
  }
}
function simpleRows(id, items, none, build) {
  const parent = $(id);
  parent.replaceChildren();
  if (!items.length) {
    parent.append(node('p', none, 'section-empty'));
    return;
  }
  for (const item of items) {
    const row = node('div', undefined, 'simple-row');
    build(row, item);
    parent.append(row);
  }
}
export function renderBranches() {
  if (!data) return;
  const query = $('branch-search').value.trim().toLocaleLowerCase();
  const branches = data.branches.filter((branch) =>
    branch.name.toLocaleLowerCase().includes(query),
  );
  simpleRows(
    'branches',
    branches,
    query ? 'No matching branches.' : 'No branches yet.',
    (row, branch) => {
      const info = node('div', undefined, 'branch-info');
      info.append(node('span', branch.name));
      if (branch.integration) info.append(node('span', 'Landing branch', 'badge'));
      row.append(info, hashButton(branch.commit));
    },
  );
}
export function render(next) {
  data = next;
  const repo = data.repository;
  document.title = `${repo.name} · YonedaRepo Local`;
  $('name').textContent = repo.name;
  $('path').textContent = repo.path;
  $('path').title = repo.path;
  $('branch').textContent = repo.branch;
  $('head').textContent = repo.head ? repo.head.slice(0, 8) : 'Empty';
  $('head').disabled = !repo.head;
  $('head').onclick = () => repo.head && copy(repo.head);
  $('local-note').textContent = repo.head
    ? 'Accepted here on this Mac.'
    : 'Ready for the first landing.';
  $('sync-state').textContent = data.cloud.enabled
    ? ({
        synced: 'Synced',
        pending: 'Pending',
        diverged: 'Needs attention',
        conflict: 'Needs attention',
        offline: 'Offline',
        refused: 'Needs sign-in',
        unpaired: 'Not connected',
      }[data.cloud.state] ?? 'Checking')
    : 'Off';
  $('sync-note').textContent = !data.cloud.enabled
    ? 'Landings stay on this Mac.'
    : data.cloud.state === 'synced'
      ? `Connected${data.cloud.host ? ` to ${data.cloud.host}` : ''}.`
      : data.cloud.state === 'unpaired'
        ? 'No cloud repository connected.'
        : 'Local landings continue while sync needs attention.';
  $('publication-note').textContent = data.cloud.enabled
    ? 'Cloud sync publishes accepted landings automatically.'
    : 'Accepted work stays local until you publish it.';
  $('push-command').textContent = `yoneda push local HEAD:${repo.branch}`;
  renderLandings();
  renderRefusals();
  renderBranches();
  simpleRows('writers', data.writers, 'No recent writers.', (row, writer) =>
    row.append(
      node('span', actor(writer.name)),
      node('span', `${writer.landings} ${writer.landings === 1 ? 'landing' : 'landings'}`),
    ),
  );
  simpleRows('checks', data.checks, 'No landing checks configured.', (row, check) =>
    row.append(node('span', check.name), node('span', label(check.status))),
  );
}
