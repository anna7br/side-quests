// Runs the Cloudflare Worker locally with plain Node (>= 18): `node proxy/dev-server.mjs` → http://127.0.0.1:8787
// Reads VAPID keys from proxy/.dev.vars (KEY=VALUE lines, create with `npm run keys`), uses an in-memory KV
// and exposes GET /__cron to run the alarm check by hand (the cron trigger only exists on Cloudflare).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { DEV: '1', ...process.env };
try {
  for (const line of fs.readFileSync(path.join(here, '.dev.vars'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/); if (m) env[m[1]] = m[2];
  }
} catch (e) { console.warn('no .dev.vars found – push alarm disabled locally (run: npm run keys)'); }

/* minimal KV shim */
const store = new Map();
env.ALARMS = {
  async get(k, type) { const v = store.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list({ prefix = '' } = {}) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
};

const PORT = +(process.env.PORT || 8787);
http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e) }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`arrive-awake backend dev server on http://127.0.0.1:${PORT} (push ${env.VAPID_PRIVATE_KEY ? 'enabled' : 'disabled'})`));

// run the alarm check every minute locally too, like the Cloudflare cron trigger
setInterval(() => worker.scheduled({}, env, { waitUntil: p => p.catch(e => console.error('cron', e)) }), 60e3);
