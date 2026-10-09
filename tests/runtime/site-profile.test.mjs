import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sitePolicy } from '../../cloudflare/worker/site-policy.ts';
test('starter check accepts standard HTML attributes and rejects missing viewport', () => {
 const root=mkdtempSync(join(tmpdir(),'yoneda-site-'));
 try {
  mkdirSync(join(root,'public'));
  const spec=sitePolicy.build.checks[0];
  const check=()=>spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:root,timeout:5000}).status;
  writeFileSync(join(root,'public/index.html'),'<html lang="en"><head><title>Site</title><meta name="viewport" content="width=device-width"></head></html>');
  assert.equal(check(),0,'Valid starter HTML must pass');
  writeFileSync(join(root,'public/index.html'),'<html><title>Site</title></html>'); assert.notEqual(check(),0);
 } finally { rmSync(root,{recursive:true,force:true}); }
});
