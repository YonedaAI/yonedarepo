// The subject has no Node/process/stdout/import capability and receives no host objects.
import { readFileSync } from 'node:fs';
import { createContext, runInContext, SourceTextModule } from 'node:vm';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const calls = JSON.parse(input);
const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
runInContext(`for (const value of [Object,Array,JSON,Reflect,Math,Date,String,Number,Boolean,RegExp]) { if (value.prototype) Object.freeze(value.prototype); Object.freeze(value); }
globalThis.console=Object.freeze({log(){},error(){},warn(){}});`, context, { timeout: 500 });
const module = new SourceTextModule(readFileSync(`${process.argv[2]}/public/events.mjs`, 'utf8'), { context });
const observations = [];
try {
  await module.link(() => { throw new Error('Subject imports are unavailable'); });
  await module.evaluate({ timeout: 1000 });
  if (typeof module.namespace.filterEvents !== 'function' || typeof module.namespace.rsvp !== 'function') throw new Error('Missing module API');
  context.__subject = module.namespace; // A namespace created in this same VM realm, no host functions.
  for (const call of calls) {
    const expression = `(function(){let writes=0;const storageWrites=[];const storage=Object.freeze({setItem(key,value){writes++;storageWrites.push({key:String(key),value:String(value)})},getItem(){return null},removeItem(){writes++}});
      Object.defineProperty(globalThis,'localStorage',{value:storage,configurable:true});Object.defineProperty(globalThis,'sessionStorage',{value:storage,configurable:true});
      const args=${JSON.stringify(call.args)};try{const value=__subject[${JSON.stringify(call.method)}](...args${call.method === 'rsvp' ? ',storage' : ''});return {value,writes,storageWrites}}catch{return {error:'subject_error',writes,storageWrites}}})()`;
    // Clone observations out of the realm; proxies/functions are rejected, no custom toJSON hooks.
    try { observations.push(structuredClone(runInContext(expression, context, { timeout: 500 }))); }
    catch { observations.push({ error: 'subject_error', writes: 0, storageWrites: [] }); }
  }
} catch { for (const _call of calls) observations.push({ error: 'module_load', writes: 0, storageWrites: [] }); }
process.stdout.write(JSON.stringify(observations));
