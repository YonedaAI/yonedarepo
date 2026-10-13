// Owner-installed runner. Candidate source cannot supply its test package or test files.
import {spawnSync} from 'node:child_process';
import {resolve,relative} from 'node:path';
const stage=process.argv[2];
if(!['initial_build','waitlist_feature','duplicate_registration_bugfix'].includes(stage)) throw new Error('Invalid protected acceptance stage');
const vitest=process.argv[3] ?? '/opt/yoneda/node_modules/vitest/vitest.mjs';
const packagePath=resolve(vitest);
if(!relative(process.cwd(),packagePath).startsWith('..')) throw new Error('Test package must be outside candidate checkout');
const result=spawnSync(process.execPath,[packagePath,'run','--configLoader','runner','--config',new URL('./vitest.config.mts',import.meta.url).pathname],{
  stdio:'inherit',timeout:70000,env:{...process.env,YONEDA_BOOKING_SUBJECT:process.cwd(),YONEDA_BOOKING_STAGE:stage},
});
process.exit(result.status===0?0:1);
