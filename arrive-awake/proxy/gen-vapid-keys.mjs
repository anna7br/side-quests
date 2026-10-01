// Generates a VAPID key pair (P-256) in the base64url format the Web Push protocol uses.
// Writes proxy/.dev.vars for local development and prints the wrangler commands for production.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const b64url = buf => Buffer.from(buf).toString('base64url');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64url(await crypto.subtle.exportKey('raw', kp.publicKey));
const privateKey = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;
const subject = process.argv[2] || 'mailto:you@example.com';

const vars = `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=${subject}\n`;
const target = path.join(here, '.dev.vars');
if (fs.existsSync(target) && !process.argv.includes('--force')) {
  console.log('.dev.vars exists, not overwriting (use --force). New keys:\n' + vars);
} else {
  fs.writeFileSync(target, vars); console.log('wrote ' + target);
}
console.log(`
For production run (each asks for the value interactively):
  npx wrangler secret put VAPID_PRIVATE_KEY     -> ${privateKey}
  npx wrangler secret put VAPID_PUBLIC_KEY      -> ${publicKey}
  npx wrangler secret put VAPID_SUBJECT         -> ${subject}
`);
