import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';

function check(source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'yoneda-policy-'));
  try {
    mkdirSync(join(directory, 'public/js'), { recursive: true });
    writeFileSync(join(directory, 'public/js/trails.js'), source);
    const command = reviewerPolicy.build.checks.find(check => check.name === 'trail-module')!;
    return spawnSync(command.argv[0], command.argv.slice(1), { cwd: directory, timeout: 5000 }).status;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const api = `({trails:[{id:'a',name:'A',lengthMiles:1,difficulty:'Easy'},{id:'b',name:'B',lengthMiles:2,difficulty:'Easy'}],filter:()=>[]})`;
it('accepts conventional browser UMD exports when self, window and the global object are aliases', () => {
  expect(check(`(function(root){root.Trails=${api}})(typeof self!=='undefined'?self:this);`)).toBe(0);
});
it('accepts explicit window exports under the same browser contract', () => {
  expect(check(`window.Trails=${api};`)).toBe(0);
});
it.each([
  'window.Trails={trails:[],filter:()=>[]};',
  `window.Trails={...${api},filter:()=>null};`,
  `window.Trails={...${api},trails:[{id:'a',name:'A'},{id:'b',name:'B'}]};`,
])('rejects a missing or invalid trail contract: %s', source => {
  expect(check(source)).toBe(1);
});
