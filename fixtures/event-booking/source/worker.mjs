import {DurableObject} from 'cloudflare:workers';
import {Booking} from './booking.mjs';
import {api} from './api.mjs';
import {assets} from './static.mjs';
export class App extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.booking = new Booking(ctx.storage.sql, fn => ctx.storage.transactionSync(fn));
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && assets[path]) {
      const [type, body] = assets[path];
      return new Response(body, {headers:{'content-type':type, 'cache-control':'no-store'}});
    }
    return api(request, this.booking);
  }
}
