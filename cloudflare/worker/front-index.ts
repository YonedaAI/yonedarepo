// Module root of the front Worker (cloudflare/wrangler.{dev,prod}-agents.jsonc): it serves the
// browser app and account sign-in; repositories belong to the platform Worker.
export { FrontEntrypoint as default } from './front-entrypoint';
