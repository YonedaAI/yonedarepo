"""Offline protocol smoke: real Gemini CLI + Rust MCP, deterministic provider/broker fixtures.
Run: docker run --rm --network none -i --entrypoint python3 IMAGE - < tests/container/gemini_smoke.py
This does not establish paid-provider completion or Cloudflare container egress.
"""
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

calls = []
tools = []


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        if self.path == '/mcp':
            calls.append(body)
            payload = {'id': 'finding:smoke', 'authority': 'assertion'}
        elif self.path.endswith(':countTokens'):
            payload = {'totalTokens': 10}
        elif ':generateContent' in self.path or ':streamGenerateContent' in self.path:
            declarations = [item for tool in body.get('tools', []) for item in tool.get('functionDeclarations', [])]
            tools.extend(item['name'] for item in declarations)
            target = next((item['name'] for item in declarations if item['name'].endswith('context_publish')), None)
            if target and not calls:
                part = {'functionCall': {'name': target, 'args': {'kind': 'finding', 'statement': 'Offline CLI tool roundtrip', 'purpose': 'Protocol verification', 'intent_id': 'intent:smoke'}}}
            else:
                part = {'text': 'SMOKE_COMPLETE'}
            payload = {'candidates': [{'content': {'role': 'model', 'parts': [part]}, 'finishReason': 'STOP'}], 'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 10, 'totalTokenCount': 20}}
        else:
            self.send_error(404)
            return
        self.send_response(200)
        streaming = ':streamGenerateContent' in self.path
        self.send_header('Content-Type', 'text/event-stream' if streaming else 'application/json')
        self.end_headers()
        data = json.dumps(payload)
        self.wfile.write((f'data: {data}\n\n' if streaming else data).encode())


server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
os.makedirs('/etc/gemini-cli', exist_ok=True)
with open('/etc/gemini-cli/settings.json', 'w') as output:
    json.dump({'security': {'auth': {'selectedType': 'gemini-api-key'}}, 'telemetry': {'enabled': False}, 'privacy': {'usageStatisticsEnabled': False}, 'model': {'maxSessionTurns': 4}, 'mcp': {'allowed': ['yonedarepo']}, 'mcpServers': {'yonedarepo': {'command': '/usr/local/bin/yoneda-runtime', 'args': ['mcp'], 'env': {'YONEDA_BROKER': origin}}}, 'tools': {'exclude': ['google_web_search', 'web_fetch']}}, output)
os.makedirs('/work/gemini-smoke', exist_ok=True)
os.chown('/work/gemini-smoke', 1000, 1000)
result = subprocess.run(['gemini', '--prompt', 'Publish a context finding, then say SMOKE_COMPLETE.', '--model', 'gemini-3.8-flash', '--output-format', 'stream-json', '--approval-mode', 'yolo'], env={'PATH': os.environ['PATH'], 'HOME': '/home/agent', 'GEMINI_API_KEY': 'offline-test-only', 'GOOGLE_GEMINI_BASE_URL': origin, 'GEMINI_TELEMETRY_ENABLED': 'false', 'GEMINI_CLI_TRUST_WORKSPACE': 'true'}, cwd='/work/gemini-smoke', user=1000, group=1000, capture_output=True, text=True, timeout=60)
assert result.returncode == 0, result.stderr[-3000:]
assert 'SMOKE_COMPLETE' in result.stdout, result.stdout[-3000:]
assert any(call.get('name') == 'context_publish' for call in calls), {'mcp_calls': calls, 'tools': tools, 'stderr': result.stderr[-2000:]}
assert calls[0]['arguments']['intent_id'] == 'intent:smoke'
print(json.dumps({'offline_fixture': True, 'cli': '0.63.0', 'real_rust_mcp_roundtrip': True, 'context_publish_calls': len(calls), 'paid_inference': False}))
server.shutdown()
