/**
 * Arrive Awake – backend (Cloudflare Worker; also runs under Node via dev-server.mjs).
 *
 * Two jobs:
 *
 * 1. ÖBB live-data proxy. ÖBB publishes no open realtime feed, but the ÖBB Scotty backend (HAFAS "mgate")
 *    answers JSON requests with live delays for every operator in Austria (ÖBB, WESTbahn, GySEV, private
 *    railways) and for most cross-border trains. Browsers cannot call it directly (no CORS), so this proxy
 *    forwards three read-only requests and returns a small normalised JSON shape.
 *
 *      GET /locations?q=Wien Hbf                           -> [{id, name, lat, lon}]
 *      GET /arrivals?station=<id>&when=<ISO>&duration=<min>[&all=1]
 *                                                          -> [{tripId, name, category, number, origin, scheduledArrival, arrival, realTime, cancelled}]
 *      GET /trip?id=<tripId>                               -> {name, realTime, stops:[{name, lat, lon, schedArr, realArr, schedDep, realDep, cancelled}]}
 *
 * 2. Server-side alarm with Web Push, so the phone rings even when the page is frozen behind a locked screen.
 *    The app stores the armed alarm here; a cron trigger (every minute) re-evaluates the expected arrival from
 *    Transitous and/or ÖBB and sends push notifications once alarm time is reached (repeated each minute until
 *    the user acknowledges, max 20). Needs a KV namespace (ALARMS) and VAPID keys (see README).
 *
 *      GET    /vapid                      -> {publicKey}
 *      POST   /alarm      (JSON body)     -> {id}        create or update an alarm
 *      DELETE /alarm?id=                                  remove it (disarm / "I'm awake")
 *      POST   /alarm/snooze?id=&until=<ms>                snooze
 *      POST   /alarm/test?id=                             send a test push right now
 *
 * Deploy: npx wrangler deploy (see wrangler.toml). Uses an unofficial ÖBB API: keep request volume personal-scale.
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';

const HAFAS = 'https://fahrplan.oebb.at/bin/mgate.exe';
const TZ = 'Europe/Vienna';
const AUTH = { type: 'AID', aid: 'OWDL4fE4ixNiPBBm' };
const CLIENT = { id: 'OEBB', type: 'IPH', name: 'oebbPROD-ADHOC', v: '6030600' };
const TRANSITOUS = 'https://api.transitous.org/api/v1/';
const UA = 'arrive-awake (+https://github.com/anna7br/side-quests)';

/* ====================== ÖBB HAFAS ====================== */
async function mgate(meth, req) {
  const body = { auth: AUTH, client: CLIENT, lang: 'deu', ver: '1.57', ext: 'OEBB.13', svcReqL: [{ meth, req }] };
  const r = await fetch(HAFAS, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Arrive Awake proxy)' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('upstream HTTP ' + r.status);
  const d = await r.json();
  const res = d.svcResL?.[0];
  if (!res) throw new Error('upstream error: ' + (d.errTxt || d.err || 'no result'));
  if (res.err && res.err !== 'OK') throw new Error('upstream ' + res.err + (res.errTxt ? ': ' + res.errTxt : ''));
  return res.res;
}
/* time helpers: HAFAS gives "HHMMSS" or "DDHHMMSS" (day offset) in Vienna local time */
function tzOffsetMinutes(utcMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs) / 60000;
}
function localToISO(yyyymmdd, hhmmss, tz = TZ) {
  if (!yyyymmdd || !hhmmss) return null;
  let dayOff = 0, t = hhmmss;
  if (t.length === 8) { dayOff = +t.slice(0, 2); t = t.slice(2); }
  const y = +yyyymmdd.slice(0, 4), mo = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  const guess = Date.UTC(y, mo - 1, d + dayOff, +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
  const off1 = tzOffsetMinutes(guess, tz);
  let utc = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(utc, tz);
  if (off2 !== off1) utc = guess - off2 * 60000;
  return new Date(utc).toISOString();
}
function isoToLocal(iso, tz = TZ) {
  const d = iso ? new Date(iso) : new Date();
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}${p.month}${p.day}`, time: `${p.hour}${p.minute}${p.second}` };
}
const crd = c => c ? { lat: c.y / 1e6, lon: c.x / 1e6 } : { lat: null, lon: null };

async function locations(q) {
  const res = await mgate('LocMatch', { input: { loc: { type: 'S', name: q + '?' }, maxLoc: 10, field: 'S' } });
  return (res.match?.locL || []).filter(l => l.type === 'S' && l.extId).map(l => ({ id: l.extId, name: l.name, ...crd(l.crd) }));
}
// HAFAS product bitmask (ÖBB): 1 RJ/ICE, 2 IC/EC, 4 D/NJ/EN, 8 R/REX, 16 S-Bahn, 32 bus, 64 ferry, 128 U-Bahn, 256 tram, 512 on-demand, higher bits: other rail
const RAIL_PRODUCTS = 1 | 2 | 4 | 8 | 16 | 1024 | 2048 | 4096;
async function arrivals(station, when, duration, all) {
  const { date, time } = isoToLocal(when);
  const req = { type: 'ARR', date, time, stbLoc: { extId: station }, maxJny: 120, dur: Math.min(+duration || 120, 720) };
  if (!all) req.jnyFltrL = [{ type: 'PROD', mode: 'INC', value: String(RAIL_PRODUCTS) }];
  const res = await mgate('StationBoard', req);
  const prods = res.common?.prodL || [];
  return (res.jnyL || []).map(j => {
    const p = prods[j.prodX] || {}; const s = j.stbStop || {};
    return {
      tripId: j.jid, name: p.name || '', category: p.prodCtx?.catOut?.trim() || '', number: p.prodCtx?.num || (p.name || '').replace(/\D/g, ''),
      origin: j.dirTxt || '', operator: p.prodCtx?.admin || '',
      scheduledArrival: localToISO(j.date, s.aTimeS), arrival: localToISO(j.date, s.aTimeR || s.aTimeS), realTime: !!s.aTimeR,
      cancelled: !!s.aCncl, track: s.aPlatfR || s.aPlatfS || null,
    };
  }).filter(a => a.scheduledArrival);
}
async function trip(id) {
  const res = await mgate('JourneyDetails', { jid: id, getPolyline: false });
  const jn = res.journey; const locL = res.common?.locL || []; const prods = res.common?.prodL || [];
  const date = jn.date;
  const stops = (jn.stopL || []).map(s => {
    const l = locL[s.locX] || {};
    return { name: l.name, id: l.extId, ...crd(l.crd), schedArr: localToISO(date, s.aTimeS), realArr: localToISO(date, s.aTimeR), schedDep: localToISO(date, s.dTimeS), realDep: localToISO(date, s.dTimeR), cancelled: !!(s.aCncl || s.dCncl) };
  });
  return { name: prods[jn.prodX]?.name || '', date, realTime: stops.some(s => s.realArr || s.realDep), cancelled: !!jn.isCncl, stops };
}

/* ====================== alarm evaluation (server copy of the app logic, no GPS) ====================== */
const minsDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 60000);
const norm = s => (s || '').toLowerCase().replace(/hauptbahnhof/g, 'hbf').replace(/[^a-z0-9äöüß]/g, '');
function distKm(a, b) { if (![a?.lat, a?.lon, b?.lat, b?.lon].every(Number.isFinite)) return Infinity; const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180, x = dLon * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180); return R * Math.hypot(dLat, x); }

async function transitousInfo(m, alarm) {
  const r = await fetch(TRANSITOUS + 'trip?tripId=' + encodeURIComponent(m.tripId), { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('transitous HTTP ' + r.status);
  const t = await r.json();
  for (const leg of (t.legs || []).filter(l => l.tripId)) {
    const stops = [leg.from, ...(leg.intermediateStops || []), leg.to].filter(Boolean);
    let idx = stops.findIndex(s => (m.stopId && s.stopId === m.stopId) || (m.parentId && s.parentId && s.parentId === m.parentId));
    if (idx < 0) idx = stops.findIndex(s => norm(s.name) === norm(alarm.station?.name) && Math.abs(minsDiff(s.scheduledArrival || s.scheduledDeparture, m.scheduledArrival)) <= 2);
    if (idx < 0) idx = stops.findIndex(s => s.scheduledArrival === m.scheduledArrival || s.scheduledDeparture === m.scheduledArrival);
    if (idx < 0) continue;
    const d = stops[idx];
    return { source: 'transitous', realTime: !!leg.realTime, cancelled: !!(leg.cancelled || d.cancelled), schedArr: d.scheduledArrival || d.scheduledDeparture, realArr: d.arrival || d.departure || d.scheduledArrival || d.scheduledDeparture };
  }
  return null;
}
async function oebbInfo(alarm) {
  const td = await trip(alarm.oebb.tripId);
  const stops = td.stops;
  let idx = stops.findIndex(s => s.schedArr && Math.abs(minsDiff(s.schedArr, alarm.scheduledArrival)) <= 1 && distKm(s, alarm.station) < 2);
  if (idx < 0) idx = stops.findIndex(s => s.schedArr && Math.abs(minsDiff(s.schedArr, alarm.scheduledArrival)) <= 1);
  if (idx < 0) return null;
  const d = stops[idx];
  return { source: 'oebb', realTime: !!td.realTime, cancelled: !!(td.cancelled || d.cancelled), schedArr: d.schedArr, realArr: d.realArr || d.schedArr };
}
async function evaluate(alarm) {
  const jobs = (alarm.members || []).map(m => transitousInfo(m, alarm));
  if (alarm.oebb?.tripId) jobs.push(oebbInfo(alarm));
  const results = await Promise.allSettled(jobs);
  const infos = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (!infos.length) throw new Error(results.find(r => r.status === 'rejected')?.reason?.message || 'no trip data');
  const preferOebb = (alarm.station?.country || '') === 'AT';
  const score = i => (i.realTime && !i.cancelled ? 4 : 0) + (!i.cancelled ? 2 : 0) + ((i.source === 'oebb') === preferOebb ? 1 : 0);
  infos.sort((a, b) => score(b) - score(a));
  const best = infos[0];
  const eta = best.realTime ? best.realArr : best.schedArr;
  return { eta, schedEta: best.schedArr, delay: minsDiff(eta, best.schedArr), cancelled: best.cancelled, realTime: best.realTime, source: best.source, at: Date.now() };
}

/* ====================== push ====================== */
const MSG = {
  en: { wake: ['Time to get up', 'Arrival in {dest} expected at {eta} ({delay}). Alarm {n}/20.'], arrived: ['Arrival now', 'The train should be arriving in {dest} now.'], cancel: ['Check your train!', 'Your stop {dest} is reported as cancelled.'], test: ['Test notification', 'Push works. Expected arrival in {dest}: {eta} ({delay}).'] },
  de: { wake: ['Aufstehen!', 'Ankunft in {dest} voraussichtlich um {eta} ({delay}). Wecker {n}/20.'], arrived: ['Ankunft jetzt', 'Der Zug sollte jetzt in {dest} ankommen.'], cancel: ['Zug prüfen!', 'Dein Halt {dest} wird als ausgefallen gemeldet.'], test: ['Test-Benachrichtigung', 'Push funktioniert. Erwartete Ankunft in {dest}: {eta} ({delay}).'] },
};
function fmtTime(iso, tz, lang) { try { return new Intl.DateTimeFormat(lang === 'de' ? 'de-AT' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || TZ }).format(new Date(iso)); } catch (e) { return String(iso).slice(11, 16); } }
function delayStr(min, lang) { if (!Number.isFinite(min) || Math.abs(min) < 1) return lang === 'de' ? 'pünktlich' : 'on time'; return (min > 0 ? '+' : '−') + Math.abs(min) + (lang === 'de' ? ' Min' : ' min'); }
async function sendPush(env, alarm, kind, ev) {
  const lang = MSG[alarm.lang] ? alarm.lang : 'en';
  const eta = ev?.eta || alarm.scheduledArrival;
  const vars = { dest: alarm.station?.name || '', eta: fmtTime(eta, alarm.station?.tz, lang), delay: delayStr(ev?.delay ?? 0, lang), n: (alarm.pushCount || 0) + 1 };
  const [title, body] = MSG[lang][kind].map(s => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''));
  const data = JSON.stringify({ kind, title, body, eta, delay: ev?.delay ?? null, dest: alarm.station?.name, id: alarm.id, lang });
  const vapid = { subject: env.VAPID_SUBJECT || 'mailto:admin@example.com', publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const payload = await buildPushPayload({ data, options: { ttl: 120, urgency: 'high', topic: 'arrive-awake' } }, alarm.subscription, vapid);
  const r = await fetch(alarm.subscription.endpoint, payload);
  if (r.status === 404 || r.status === 410) return 'gone';
  if (!r.ok) throw new Error('push service HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return 'sent';
}

/* ====================== alarm store & cron ======================
 * KV on the Workers free plan allows 1000 writes, 1000 lists and 100k reads per day, so the cron must be frugal:
 * alarms are tracked in one index key (read, never listed), evaluation results are not written back every minute
 * (only pushes, snoozes and the ÖBB match are persisted), and far-away alarms are evaluated only every 10 minutes. */
const key = id => 'alarm:' + id;
const INDEX = 'alarms:index';
const ttlFor = a => Math.max(600, Math.round((new Date(a.scheduledArrival).getTime() + 8 * 3600e3 - Date.now()) / 1000));
const readIndex = async env => (await env.ALARMS.get(INDEX, 'json')) || [];
const writeIndex = (env, ids) => env.ALARMS.put(INDEX, JSON.stringify(ids), { expirationTtl: 60 * 86400 });
async function addToIndex(env, id) { const ids = await readIndex(env); if (!ids.includes(id)) await writeIndex(env, [...ids, id]); }
async function removeAlarm(env, id) { await env.ALARMS.delete(key(id)); const ids = await readIndex(env); if (ids.includes(id)) await writeIndex(env, ids.filter(x => x !== id)); }
async function runAlarms(env, force = false) {
  if (!env.ALARMS) return { error: 'KV not configured' };
  const ids = await readIndex(env);
  const out = []; const gone = [];
  await Promise.all(ids.map(async id => {
    const a = await env.ALARMS.get(key(id), 'json'); if (!a) { gone.push(id); return; }
    const now = Date.now(); const log = { id };
    const schedMs = new Date(a.scheduledArrival).getTime();
    if (now > schedMs + 6 * 3600e3) { await env.ALARMS.delete(key(id)); gone.push(id); log.deleted = 'expired'; out.push(log); return; }
    // every minute inside the last 3 h before the scheduled alarm time (or once pushing started), else only every 10 min
    const near = now >= schedMs - a.lead * 60e3 - 3 * 3600e3 || (a.pushCount || 0) > 0;
    if (!near && !force && new Date(now).getUTCMinutes() % 10 !== 0) { log.skipped = true; out.push(log); return; }
    let ev = null;
    try { ev = await evaluate(a); } catch (e) { log.err = String(e.message || e); ev = a.last || null; }
    const etaMs = ev?.eta ? new Date(ev.eta).getTime() : schedMs;
    const alarmAt = etaMs - a.lead * 60e3;
    log.eta = new Date(etaMs).toISOString(); log.alarmAt = new Date(alarmAt).toISOString(); log.source = ev?.source;
    let kind = null, dirty = false;
    if (ev?.cancelled && !a.cancelPushed) { kind = 'cancel'; a.cancelPushed = true; dirty = true; }
    else if (now >= alarmAt && now >= (a.snoozeUntil || 0) && (a.pushCount || 0) < 20 && now - (a.lastPush || 0) >= 50e3) kind = now >= etaMs ? 'arrived' : 'wake';
    if (kind) {
      try { const res = await sendPush(env, a, kind, ev); log.push = kind + ':' + res; if (res === 'gone') { await env.ALARMS.delete(key(id)); gone.push(id); out.push(log); return; } a.pushCount = (a.pushCount || 0) + 1; a.lastPush = now; a.last = ev; dirty = true; }
      catch (e) { log.push = 'error: ' + e.message; }
    }
    if (now > etaMs + 20 * 60e3) { await env.ALARMS.delete(key(id)); gone.push(id); log.deleted = 'done'; out.push(log); return; }
    if (dirty) await env.ALARMS.put(key(id), JSON.stringify(a), { expirationTtl: ttlFor(a) });
    out.push(log);
  }));
  if (gone.length) await writeIndex(env, ids.filter(x => !gone.includes(x)));
  return { checked: ids.length, alarms: out };
}

/* ====================== HTTP ====================== */
function json(data, status, origin, extra = {}) {
  return new Response(data === null ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store', ...extra } });
}
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runAlarms(env)); },
  async fetch(request, env = {}) {
    const origin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') return json(null, 204, origin);
    const url = new URL(request.url); const p = url.searchParams; const path = url.pathname.replace(/\/+$/, '');
    const is = s => path.endsWith(s);
    try {
      /* live data */
      if (is('/locations')) { const q = p.get('q'); if (!q) return json({ error: 'q required' }, 400, origin); return json(await locations(q), 200, origin, { 'Cache-Control': 'public, max-age=60' }); }
      if (is('/arrivals')) { const st = p.get('station'); if (!st) return json({ error: 'station required' }, 400, origin); return json(await arrivals(st, p.get('when'), p.get('duration'), p.get('all') === '1'), 200, origin, { 'Cache-Control': 'public, max-age=20' }); }
      if (is('/trip')) { const id = p.get('id'); if (!id) return json({ error: 'id required' }, 400, origin); return json(await trip(id), 200, origin, { 'Cache-Control': 'public, max-age=20' }); }
      /* push alarm */
      if (is('/vapid')) return json({ publicKey: env.VAPID_PUBLIC_KEY || null, push: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.ALARMS) }, 200, origin);
      if (is('/alarm') || is('/alarm/snooze') || is('/alarm/test')) {
        if (!env.ALARMS || !env.VAPID_PRIVATE_KEY) return json({ error: 'push alarm not configured on this server (KV + VAPID keys)' }, 503, origin);
        if (request.method === 'POST' && is('/alarm')) {
          const b = await request.json();
          if (!b?.subscription?.endpoint || !b.scheduledArrival || !b.station) return json({ error: 'subscription, station, scheduledArrival required' }, 400, origin);
          const id = String(b.id || crypto.randomUUID()).slice(0, 80);
          const prev = await env.ALARMS.get(key(id), 'json');
          const a = { id, subscription: b.subscription, lead: Math.min(180, Math.max(1, +b.lead || 20)), lang: b.lang === 'de' ? 'de' : 'en', station: b.station, scheduledArrival: b.scheduledArrival, members: (b.members || []).slice(0, 8), oebb: b.oebb || null, snoozeUntil: +b.snoozeUntil || 0, createdAt: prev?.createdAt || Date.now(), pushCount: prev?.pushCount || 0, lastPush: prev?.lastPush || 0, last: prev?.last || null };
          await env.ALARMS.put(key(id), JSON.stringify(a), { expirationTtl: ttlFor(a) });
          if (!prev) await addToIndex(env, id);
          return json({ id, ok: true }, 200, origin);
        }
        const id = p.get('id'); if (!id) return json({ error: 'id required' }, 400, origin);
        const a = await env.ALARMS.get(key(id), 'json');
        if (request.method === 'DELETE') { if (a) await removeAlarm(env, id); return json({ ok: true }, 200, origin); }
        if (!a) return json({ error: 'unknown alarm' }, 404, origin);
        if (is('/alarm/snooze')) { a.snoozeUntil = +p.get('until') || Date.now() + 5 * 60e3; a.lastPush = 0; await env.ALARMS.put(key(id), JSON.stringify(a), { expirationTtl: ttlFor(a) }); return json({ ok: true, snoozeUntil: a.snoozeUntil }, 200, origin); }
        if (is('/alarm/test')) { let ev = a.last; try { ev = await evaluate(a); } catch (e) {} const res = await sendPush(env, a, 'test', ev); return json({ ok: res === 'sent', result: res, eta: ev?.eta || null }, 200, origin); }
      }
      if (is('/__cron') && env.DEV) return json(await runAlarms(env, true), 200, origin);
      return json({ ok: true, service: 'arrive-awake backend', push: !!(env.VAPID_PUBLIC_KEY && env.ALARMS), endpoints: ['/locations?q=', '/arrivals?station=&when=&duration=', '/trip?id=', '/vapid', 'POST /alarm', 'DELETE /alarm?id=', 'POST /alarm/snooze?id=&until=', 'POST /alarm/test?id='] }, 200, origin);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, origin);
    }
  }
};
