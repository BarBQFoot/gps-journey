import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 3000);
const root = join(process.cwd(), 'dist', 'gps-journey', 'browser');
const clients = new Set();
const rooms = new Map();
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.ico':'image/x-icon','.png':'image/png','.json':'application/json' };

function safeRoom(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
}

function broadcast(roomId, event) {
  const message = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) if (client.roomId === roomId) client.res.write(message);
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/events' && req.method === 'GET') {
    const roomId = safeRoom(url.searchParams.get('roomId'));
    if (!roomId) { res.writeHead(400).end('roomId required'); return; }
    res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});
    res.write(': connected\n\n');
    const client = { roomId, res }; clients.add(client);
    const state = rooms.get(roomId);
    res.write(`data: ${JSON.stringify({type:'share-status', active:!!state?.sharing})}\n\n`);
    if (state?.pickup) res.write(`data: ${JSON.stringify({type:'pickup', point:state.pickup})}\n\n`);
    if (state?.dropoff) res.write(`data: ${JSON.stringify({type:'dropoff', point:state.dropoff})}\n\n`);
    if (state?.sharing && state?.location) res.write(`data: ${JSON.stringify({type:'location', point:state.location})}\n\n`);
    req.on('close', () => clients.delete(client));
    return;
  }

  if (url.pathname === '/api/room-event' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { if (body.length < 20_000) body += chunk; });
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        const roomId = safeRoom(event.roomId);
        const pointEvent = ['location','pickup','dropoff'].includes(event.type);
        const statusEvent = event.type === 'share-status' && typeof event.active === 'boolean';
        if (!roomId || (!pointEvent && !statusEvent) || (pointEvent && (!Number.isFinite(event.point?.lat) || !Number.isFinite(event.point?.lon)))) {
          res.writeHead(400, {'content-type':'application/json'}).end(JSON.stringify({error:'invalid event'})); return;
        }
        const state = rooms.get(roomId) || {};
        if (event.type === 'location') state.location = event.point;
        if (event.type === 'pickup') state.pickup = event.point;
        if (event.type === 'dropoff') state.dropoff = event.point;
        if (event.type === 'share-status') state.sharing = event.active;
        rooms.set(roomId, state);
        broadcast(roomId, event.type === 'share-status' ? { type:event.type, active:event.active } : { type:event.type, point:event.point });
        res.writeHead(204).end();
      } catch { res.writeHead(400).end('invalid json'); }
    });
    return;
  }

  let file = normalize(join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, {'content-type':types[extname(file)] || 'application/octet-stream'}).end(await readFile(file));
  } catch {
    res.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(await readFile(join(root, 'index.html')));
  }
}).listen(port, () => console.log(`GPS Journey: http://localhost:${port}`));
