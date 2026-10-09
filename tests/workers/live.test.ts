import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach,expect,it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
const bindings=env as unknown as Env;
afterEach(reset);
it('sends payload-free refresh signals so revoked sessions cannot read future context',async()=>{
 const live=bindings.LIVE.get(bindings.LIVE.idFromName('private-repo'));
 const response=await live.fetch('https://live/connect',{headers:{upgrade:'websocket'}});
 const socket=response.webSocket!;socket.accept();
 try {
  const received=new Promise<string>(resolve=>socket.addEventListener('message',event=>resolve(String(event.data)),{once:true}));
  await live.fetch('https://live/notify',{method:'POST',body:JSON.stringify({type:'context.published',payload:{statement:'private future brief',provider:'secret metadata'}})});
  expect(await received).toBe('{"type":"resync"}');
 } finally {socket.close();}
});
