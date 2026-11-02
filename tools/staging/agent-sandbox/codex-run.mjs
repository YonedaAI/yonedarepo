// Codex in the agent sandbox. Codex has no yoneda plugin, so this does what the Claude Code and
// opencode hooks do, by the same public routes: the repository's context goes in front of the
// prompt and is recorded as this session's delivery, Codex runs, and its pushed commit gets a
// session record with a transcript. Arguments: the model, then the task. Codex's JSON events go to
// stdout for the run's evidence.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [model, task] = process.argv.slice(2);
const session = `codex:${randomUUID()}`;
const origin = process.env.YONEDA_ORIGIN.replace(/\/$/, '');
const repo = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim().split('/').pop();
const headers = { authorization: `Bearer ${process.env.YONEDA_TOKEN}`, 'content-type': 'application/json', 'x-yoneda-own-traffic': '1' };
const api = async (path, init) => {
  const res = await fetch(`${origin}/api/v1/repos/${repo}${path}`, { headers, ...init });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

const packet = execFileSync('yoneda', ['context'], { encoding: 'utf8' });
const { memories = [] } = await api('/context?memories=8');
const shown = memories.filter((m) => packet.includes(String(m.text).split('\n')[0].slice(0, 60)));
await api('/context/deliveries', { method: 'POST', body: JSON.stringify({ session_id: session, trigger: 'start', subject: null, items: shown.map((m) => ({ type: 'memory', id: m.id })), bytes: Buffer.byteLength(packet) }) });

const prompt = `${packet}\n---\n\n${task}`;
const turns = [{ kind: 'prompt', text: task }];
const provider = '{ name = "gateway", base_url = "http://127.0.0.1:8719/openai", env_key = "SANDBOX_SHIM_KEY", wire_api = "responses" }';
const codex = spawn('codex', ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--model', model, '-c', 'model_reasoning_effort="medium"', '-c', 'model_provider="gateway"', '-c', `model_providers.gateway=${provider}`, '-c', 'mcp_servers={}', '-'], { env: { ...process.env, YONEDA_SESSION_ID: session }, stdio: ['pipe', 'pipe', 'inherit'] });
codex.stdin.end(prompt);

let last = '';
for await (const line of createInterface({ input: codex.stdout })) {
  console.log(line);
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  const item = event.item;
  if (event.type !== 'item.completed' || !item) continue;
  if (item.type === 'agent_message') {
    last = item.text ?? '';
    turns.push({ kind: 'reply', text: last });
  } else if (item.type === 'command_execution') turns.push({ kind: 'tool', name: 'shell', subject: String(item.command ?? '').slice(0, 280), output: String(item.aggregated_output ?? '').slice(0, 4000), error: Boolean(item.exit_code) });
  else if (item.type === 'file_change') turns.push({ kind: 'tool', name: 'edit', subject: (item.changes ?? []).map((c) => c.path).join(', ').slice(0, 280) });
}
const code = await new Promise((done) => codex.on('close', done));
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
const pushed = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], { encoding: 'utf8' }).stdout.trim();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (pushed === head) {
  writeFileSync('/tmp/codex-transcript.json', JSON.stringify({ context: packet, turns }));
  execFileSync('yoneda', ['session', 'record', '--cli', 'codex', '--summary', last.slice(0, 500) || 'Codex run', '--model', `openai/${model}`, '--session-id', session, '--transcript', '/tmp/codex-transcript.json'], { stdio: 'inherit' });
}
process.exit(code ?? 1);
