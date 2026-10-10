import { sitePolicy } from './site-policy';
/** These check commands belong to the platform approval, not candidate package scripts. */
export const reviewerPolicy = {
  ...sitePolicy,
  version: 'reviewer-v2',
  required_checks: ['site', 'trail-module', 'bilingual', 'registry-egress'],
  build: {
    setup: [
      {
        name: 'prepare-registry-check',
        argv: [
          'node',
          '-e',
          "const fs=require('node:fs');const d='/tmp/yoneda-registry-check';fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+'/package.json',JSON.stringify({name:'yoneda-egress-check',version:'1.0.0',private:true,dependencies:{'is-number':'7.0.0'}}))",
        ],
        timeout_seconds: 10,
      },
    ],
    checks: [
      ...sitePolicy.build.checks,
      {
        name: 'trail-module',
        argv: [
          'node',
          '-e',
          "const vm=require('node:vm'),fs=require('node:fs');const c={};c.window=c;c.self=c;vm.createContext(c);vm.runInContext(fs.readFileSync('public/js/trails.js','utf8'),c,{timeout:1000});const t=c.window.Trails;if(!t||!Array.isArray(t.trails)||t.trails.length<2||typeof t.filter!=='function')process.exit(1);for(const v of t.trails)if(!v.id||!v.name||!Number.isFinite(v.lengthMiles)||!v.difficulty)process.exit(1);if(!Array.isArray(t.filter({query:''})))process.exit(1)",
        ],
        timeout_seconds: 10,
      },
      {
        name: 'bilingual',
        argv: [
          'node',
          '-e',
          "const fs=require('node:fs'),h=fs.readFileSync('public/index.html','utf8');if(!h.includes('js/trails.js')||!h.includes('Trails')||!/(español|espanol|spanish|es-ES|Español)/i.test(h)||!/<(button|select)\\b/i.test(h))process.exit(1)",
        ],
        timeout_seconds: 10,
      },
      {
        name: 'registry-egress',
        argv: [
          'sh',
          '-c',
          'npm install --prefix /tmp/yoneda-registry-check --package-lock-only --ignore-scripts --no-audit --no-fund --fetch-timeout=10000 --fetch-retries=1 --registry=https://registry.npmjs.org/ && npm ci --prefix /tmp/yoneda-registry-check --ignore-scripts --no-audit --no-fund --fetch-timeout=10000 --fetch-retries=1 --registry=https://registry.npmjs.org/',
        ],
        timeout_seconds: 50,
      },
    ],
    static_dir: 'public',
  },
};
