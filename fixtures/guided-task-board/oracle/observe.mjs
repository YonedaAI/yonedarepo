// Candidate functions execute without process, filesystem, stdout or host objects.
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { createContext, runInContext, SourceTextModule } from 'node:vm';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const calls = JSON.parse(input);
const root = resolve(process.argv[2], 'public');
if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
  throw new Error('Regular public directory required');
const context = createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});
runInContext(
  `for (const value of [Object,Array,JSON,Reflect,Math,Date,String,Number,Boolean,RegExp]) {
  if (value.prototype) Object.freeze(value.prototype); Object.freeze(value);
} globalThis.console=Object.freeze({log(){},error(){},warn(){}});`,
  context,
  { timeout: 500 },
);
const cache = new Map();
function load(path) {
  const absolute = resolve(path);
  if (!absolute.startsWith(root + '/') || !absolute.endsWith('.mjs'))
    throw new Error('Import outside public task module');
  let current = root;
  for (const part of relative(root, absolute).split('/')) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Module symlinks are unavailable');
  }
  if (!lstatSync(absolute).isFile()) throw new Error('Regular module file required');
  if (!cache.has(absolute))
    cache.set(
      absolute,
      new SourceTextModule(readFileSync(absolute, 'utf8'), {
        context,
        identifier: absolute,
      }),
    );
  return cache.get(absolute);
}
const observations = [];
try {
  const module = load(resolve(root, 'tasks.mjs'));
  await module.link((specifier, referring) => {
    if (!specifier.startsWith('./') && !specifier.startsWith('../'))
      throw new Error('Only scoped relative modules');
    return load(resolve(dirname(referring.identifier), specifier));
  });
  await module.evaluate({ timeout: 5000 });
  context.__subject = module.namespace;
  for (const call of calls) {
    const expression = `(function(){const args=${JSON.stringify(call.args)};
      try {return {value:__subject[${JSON.stringify(call.method)}](...args)}}
      catch {return {error:'subject_error'}}})()`;
    try {
      // A cold container can spend most of a second loading collation data on first use.
      observations.push(structuredClone(runInContext(expression, context, { timeout: 3000 })));
    } catch {
      observations.push({ error: 'subject_error' });
    }
  }
} catch {
  for (const _call of calls) observations.push({ error: 'module_load' });
}
process.stdout.write(JSON.stringify(observations));
