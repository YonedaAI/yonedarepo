// Owner-installed runner. Candidate source cannot supply its test package or test files.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
const stage=process.argv[2];
if(!['initial_build','waitlist_feature','duplicate_registration_bugfix'].includes(stage)) throw new Error('Invalid protected acceptance stage');
const vitest=process.argv[3] ?? '/opt/yoneda/node_modules/vitest/vitest.mjs';
const packagePath=resolve(vitest);
if(!relative(process.cwd(),packagePath).startsWith('..')) throw new Error('Test package must be outside candidate checkout');
// Packages, tests and HOME may be read-only: Vitest's caches and its API token file
// (XDG data dir) go to a private per-run directory instead.
const scratch=mkdtempSync(join(tmpdir(),'yoneda-booking-'));
let result;
try{
  result=spawnSync(process.execPath,[packagePath,'run','--configLoader','runner','--config',new URL('./vitest.config.mts',import.meta.url).pathname],{
    stdio:'inherit',timeout:70000,env:{...process.env,XDG_DATA_HOME:scratch,YONEDA_BOOKING_SCRATCH:scratch,YONEDA_BOOKING_SUBJECT:process.cwd(),YONEDA_BOOKING_STAGE:stage},
  });
}finally{rmSync(scratch,{recursive:true,force:true});}
process.exit(result.status===0?0:1);
