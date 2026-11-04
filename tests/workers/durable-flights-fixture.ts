import { DurableObject } from 'cloudflare:workers';
import { Flights } from '../../cloudflare/worker/flights';
import { inScope } from '../../cloudflare/worker/request-scope';

/** Only tests: real DO I/O that outlives the HTTP request which started it. */
export class DurableFlightsFixture extends DurableObject<{ OBJECTS: R2Bucket }> {
  #loads = new Flights<string>(this.ctx);
  #release: (() => void) | undefined;
  #calls = 0;
  #joined = 0;

  fetch(req: Request) {
    return inScope({ req }, async () => {
      const path = new URL(req.url).pathname;
      if (path === '/stats') return Response.json({ calls: this.#calls, joined: this.#joined });
      if (path === '/release') {
        this.#release?.();
        return new Response('released');
      }
      const { work, joined } = this.#loads.join('read', async () => {
        this.#calls++;
        const key = `flights/${this.ctx.id}`;
        // Real binding I/O before and after the initiating caller is cancelled.
        const released = new Promise<void>((resolve) => { this.#release = resolve; });
        await this.env.OBJECTS.put(key, 'held');
        await released;
        await this.env.OBJECTS.put(key, 'ready');
        return (await this.env.OBJECTS.get(key))!.text();
      });
      if (joined) this.#joined++;
      return new Response(await work);
    });
  }
}
