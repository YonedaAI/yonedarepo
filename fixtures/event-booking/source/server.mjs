import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {Booking} from './booking.mjs';
import {api} from './api.mjs';
const path = process.env.DATABASE_PATH ?? './data/booking.sqlite';
mkdirSync(dirname(path), {recursive:true});
const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get()) {
  const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url)));
  db.exec('BEGIN IMMEDIATE');
  try { for (const migration of schema.migrations) for (const sql of migration.sql) db.exec(sql);
    for (const sql of schema.seed) db.exec(sql); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
const sql = {exec:(query,...args) => db.prepare(query).all(...args)};
const booking = new Booking(sql, fn => {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
});
const staticFiles = {'/':['index.html','text/html'], '/app.mjs':['app.mjs','text/javascript'], '/style.css':['style.css','text/css']};
const server = createServer(async (incoming, outgoing) => {
  try {
    const route = new URL(incoming.url, 'http://localhost').pathname;
    let response;
    if (incoming.method === 'GET' && staticFiles[route]) {
      const [file,type] = staticFiles[route];
      response = new Response(readFileSync(new URL(`./public/${file}`, import.meta.url)), {headers:{'content-type':type}});
    } else {
      const chunks=[]; let bytes=0;
      for await (const chunk of incoming) { bytes+=chunk.length; if (bytes>16384) { outgoing.writeHead(413);outgoing.end();return; } chunks.push(chunk); }
      response = await api(new Request(`http://localhost${incoming.url}`, {method:incoming.method,
        headers:incoming.headers, ...(incoming.method !== 'GET' && incoming.method !== 'HEAD' ? {body:Buffer.concat(chunks)} : {})}), booking);
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500); outgoing.end('{"error":"internal_error"}'); }
});
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({port:server.address().port})}\n`);
});
process.on('SIGTERM', () => server.close(() => {db.close();process.exit(0);}));
