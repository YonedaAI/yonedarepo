import { copy, render, renderBranches } from '/local/render.js';

const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
};
let refreshing = false;
let hasLoaded = false;
let lastPayload;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  $('refresh').disabled = true;
  $('retry').disabled = true;
  try {
    const response = await fetch('/local/dashboard', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Service unavailable');
    const next = await response.json();
    if (!next.repository || !Array.isArray(next.landings) || !Array.isArray(next.refusals))
      throw new Error('Unreadable response');
    const payload = JSON.stringify(next);
    if (payload !== lastPayload) {
      render(next);
      lastPayload = payload;
    }
    hasLoaded = true;
    $('loading').hidden = true;
    $('error').hidden = true;
    $('connection').className = 'service-state ready';
    $('connection').replaceChildren(
      node('span', '', 'status-dot'),
      node('span', 'Service running'),
    );
    $('updated').textContent =
      `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } catch {
    $('error').hidden = false;
    $('loading').hidden = true;
    $('connection').className = 'service-state offline';
    $('connection').replaceChildren(
      node('span', '', 'status-dot'),
      node('span', 'Service unavailable'),
    );
    if (!hasLoaded) {
      for (const id of ['landings', 'writers', 'checks', 'branches'])
        $(id).replaceChildren(node('p', `Could not load ${id}.`, 'section-empty'));
      $('path').textContent = 'Waiting for the local service.';
      $('local-note').textContent = 'Could not read the accepted revision.';
      $('sync-note').textContent = 'Could not read cloud sync state.';
    }
  } finally {
    refreshing = false;
    $('refresh').disabled = false;
    $('retry').disabled = false;
  }
}
$('refresh').addEventListener('click', refresh);
$('retry').addEventListener('click', refresh);
$('copy-command').addEventListener('click', () => copy($('push-command').textContent));
$('branch-search').addEventListener('input', renderBranches);
const tabs = [$('landings-tab'), $('refusals-tab')];
function selectTab(tab, focus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    $(item.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) tab.focus();
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      selectTab(
        event.key === 'Home'
          ? tabs[0]
          : event.key === 'End'
            ? tabs[1]
            : tabs[1 - tabs.indexOf(tab)],
        true,
      );
    }
  });
}
function theme(choice) {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}
let preference = 'system';
try {
  preference = localStorage.getItem('yoneda-local-theme') ?? 'system';
} catch {}
if (!['system', 'light', 'dark'].includes(preference)) preference = 'system';
$('theme').value = preference;
theme(preference);
$('theme').addEventListener('change', (event) => {
  const value = event.target.value;
  theme(value);
  try {
    localStorage.setItem('yoneda-local-theme', value);
  } catch {}
});
await refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 5000);
