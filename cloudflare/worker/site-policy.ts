export const sitePolicy = {
  version: 'static-v1',
  suite: 'commands-v1',
  environment: 'linux-node24-rust1.94-v1',
  required_checks: ['site'],
  build: {
    setup: [],
    checks: [
      {
        name: 'site',
        argv: [
          'node',
          '-e',
          "const fs=require('node:fs');const html=fs.readFileSync('public/index.html','utf8');if(!/<html[\\s>]/i.test(html)||!/<title[\\s>]/i.test(html)||!/<meta[^>]*viewport/i.test(html))process.exit(1)",
        ],
        timeout_seconds: 10,
      },
    ],
    static_dir: 'public',
  },
};
