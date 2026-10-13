import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
export const stages=['initial_build','waitlist_feature','duplicate_registration_bugfix'];
export function protectedBundle(){
  const files={};
  for(const path of ['fixtures/event-booking/oracle/entrypoint.ts','fixtures/event-booking/oracle/vitest.config.mts',
    'fixtures/event-booking/oracle/acceptance.test.ts','fixtures/event-booking/oracle/run.mjs','fixtures/event-booking/source/schema.json']) {
    files[path]={content:readFileSync(resolve(root,path),'utf8'),executable:false};
  }
  const sorted=Object.fromEntries(Object.entries(files).sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
  return {files:sorted,digest:createHash('sha256').update(JSON.stringify(sorted)).digest('hex')};
}
export function appProfile(){
  const schema=JSON.parse(readFileSync(resolve(root,'fixtures/event-booking/source/schema.json'),'utf8'));
  return {version:1,entrypoint:'dist/worker.js',export_name:'App',migrations:schema.migrations,seed:schema.seed};
}
export function bookingPolicy(stage){
  if(!stages.includes(stage))throw new Error('Unknown booking acceptance stage');
  return {version:`booking-${stage}-v1`,suite:'commands-v1',environment:'linux-node24-rust1.94-v1',required_checks:['booking-acceptance'],
    build:{setup:[{name:'bundle',argv:['node','build.mjs'],timeout_seconds:10}],
      checks:[{name:'booking-acceptance',argv:['node','/opt/yoneda/test-bundle/fixtures/event-booking/oracle/run.mjs',stage],timeout_seconds:80}],
      app:appProfile(),test_bundle:{digest:protectedBundle().digest,protected_paths:['schema.json','build.mjs']}}};
}
