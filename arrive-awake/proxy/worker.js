/**
 * Arrive Awake – backend (Cloudflare Worker; also runs under Node via dev-server.mjs).
 *
 * 1. Extra live-data sources that browsers cannot call directly (no CORS / no open feed), returned in one
 *    normalised JSON shape. Each source lives under its own prefix:
 *
 *      /oebb  ÖBB Scotty (HAFAS mgate): every operator in Austria (ÖBB, WESTbahn, GySEV, private railways),
 *             plus German and Swiss stations and many cross-border trains.
 *      /it    RFI arrival boards (iechub.rfi.it): every train in Italy with its delay at the chosen station.
 *      /hu    MÁV Vonatinfo: live delay and position of every train in Hungary (no stop list).
 *
 *      GET /{src}/locations?q=                                  -> [{id, name, lat, lon}]
 *      GET /{src}/arrivals?station=<id>&when=<ISO>&duration=<min>
 *                                                               -> [{tripId, name, category, number, origin, scheduledArrival, arrival, realTime, cancelled}]
 *      GET /oebb/trip?id=<tripId>                               -> {name, realTime, cancelled, delay, stops:[{name, id, lat, lon, schedArr, realArr, schedDep, realDep, cancelled}]}
 *      GET /it/delay?station=<id>&number=<train number>         -> {found, name, number, delay, realTime, cancelled, scheduledArrival}
 *      GET /hu/delay?number=<train number>                      -> {found, name, number, delay, lat, lon, relation}
 *    (/locations, /arrivals, /trip without prefix = /oebb/…, kept for older app versions)
 *
 * 2. Server-side alarm with Web Push, so the phone rings even when the page is frozen behind a locked screen.
 *    The app stores the armed alarm here; a cron trigger (every minute) re-evaluates the expected arrival from
 *    Transitous and the extra sources and sends push notifications once alarm time is reached (repeated each
 *    minute until acknowledged, max 20). Needs a KV namespace (ALARMS) and VAPID keys (see README).
 *
 *      GET    /vapid                      -> {publicKey, push}
 *      POST   /alarm      (JSON body)     -> {id}        create or update an alarm
 *      DELETE /alarm?id=                                  remove it (disarm / "I'm awake")
 *      POST   /alarm/snooze?id=&until=<ms>                snooze
 *      POST   /alarm/test?id=                             send a test push right now
 *      POST   /pushover/test {user}                       optional loud alarm: send a test message to a Pushover user key (needs secret PUSHOVER_TOKEN)
 *
 * Deploy: npx wrangler deploy (see wrangler.toml). All upstreams are unofficial APIs: keep request volume personal-scale.
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';

const TRANSITOUS = 'https://api.transitous.org/api/v1/';
const UA = 'arrive-awake (+https://github.com/anna7br/side-quests)';
const BROWSER_UA = 'Mozilla/5.0 (Arrive Awake backend; +https://github.com/anna7br/side-quests)';

/* ====================== shared helpers ====================== */
const minsDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 60000);
const norm = s => (s || '').toLowerCase().replace(/hauptbahnhof/g, 'hbf').replace(/[^a-z0-9äöüß]/g, '');
function distKm(a, b) { if (![a?.lat, a?.lon, b?.lat, b?.lon].every(Number.isFinite)) return Infinity; const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180, x = dLon * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180); return R * Math.hypot(dLat, x); }
function tzOffsetMinutes(utcMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs) / 60000;
}
function localToISO(yyyymmdd, hhmmss, tz) {               // HAFAS "HHMMSS" / "DDHHMMSS" in a local time zone
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
function localParts(iso, tz) {
  const d = iso ? new Date(iso) : new Date();
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  return Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
}
const msToISO = ms => (Number.isFinite(ms) && ms > 0) ? new Date(ms).toISOString() : null;

/* ====================== source: ÖBB Scotty (HAFAS) ====================== */
const HAFAS = 'https://fahrplan.oebb.at/bin/mgate.exe';
const AT_TZ = 'Europe/Vienna';
async function mgate(meth, req) {
  const body = { auth: { type: 'AID', aid: 'OWDL4fE4ixNiPBBm' }, client: { id: 'OEBB', type: 'IPH', name: 'oebbPROD-ADHOC', v: '6030600' }, lang: 'deu', ver: '1.57', ext: 'OEBB.13', svcReqL: [{ meth, req }] };
  const r = await fetch(HAFAS, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': BROWSER_UA }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('upstream HTTP ' + r.status);
  const d = await r.json();
  const res = d.svcResL?.[0];
  if (!res) throw new Error('upstream error: ' + (d.errTxt || d.err || 'no result'));
  if (res.err && res.err !== 'OK') throw new Error('upstream ' + res.err + (res.errTxt ? ': ' + res.errTxt : ''));
  return res.res;
}
const crd = c => c ? { lat: c.y / 1e6, lon: c.x / 1e6 } : { lat: null, lon: null };
// HAFAS product bitmask (ÖBB): 1 RJ/ICE, 2 IC/EC, 4 D/NJ/EN, 8 R/REX, 16 S-Bahn, 32 bus, 64 ferry, 128 U-Bahn, 256 tram, 512 on-demand, higher bits: other rail
const RAIL_PRODUCTS = 1 | 2 | 4 | 8 | 16 | 1024 | 2048 | 4096;
const oebb = {
  async locations(q) {
    const res = await mgate('LocMatch', { input: { loc: { type: 'S', name: q + '?' }, maxLoc: 10, field: 'S' } });
    return (res.match?.locL || []).filter(l => l.type === 'S' && l.extId).map(l => ({ id: l.extId, name: l.name, ...crd(l.crd) }));
  },
  async arrivals(station, when, duration, all) {
    const p = localParts(when, AT_TZ);
    const req = { type: 'ARR', date: `${p.year}${p.month}${p.day}`, time: `${p.hour}${p.minute}${p.second}`, stbLoc: { extId: station }, maxJny: 120, dur: Math.min(+duration || 120, 720) };
    if (!all) req.jnyFltrL = [{ type: 'PROD', mode: 'INC', value: String(RAIL_PRODUCTS) }];
    const res = await mgate('StationBoard', req);
    const prods = res.common?.prodL || [];
    return (res.jnyL || []).map(j => {
      const pr = prods[j.prodX] || {}; const s = j.stbStop || {};
      return { tripId: j.jid, name: pr.name || '', category: pr.prodCtx?.catOut?.trim() || '', number: pr.prodCtx?.num || (pr.name || '').replace(/\D/g, ''), origin: j.dirTxt || '', operator: pr.prodCtx?.admin || '',
        scheduledArrival: localToISO(j.date, s.aTimeS, AT_TZ), arrival: localToISO(j.date, s.aTimeR || s.aTimeS, AT_TZ), realTime: !!s.aTimeR, cancelled: !!s.aCncl, track: s.aPlatfR || s.aPlatfS || null };
    }).filter(a => a.scheduledArrival);
  },
  async trip(id) {
    const res = await mgate('JourneyDetails', { jid: id, getPolyline: false });
    const jn = res.journey; const locL = res.common?.locL || []; const prods = res.common?.prodL || [];
    const date = jn.date;
    const stops = (jn.stopL || []).map(s => { const l = locL[s.locX] || {}; return { name: l.name, id: l.extId, ...crd(l.crd), schedArr: localToISO(date, s.aTimeS, AT_TZ), realArr: localToISO(date, s.aTimeR, AT_TZ), schedDep: localToISO(date, s.dTimeS, AT_TZ), realDep: localToISO(date, s.dTimeR, AT_TZ), cancelled: !!(s.aCncl || s.dCncl) }; });
    return { name: prods[jn.prodX]?.name || '', date, realTime: stops.some(s => s.realArr || s.realDep), cancelled: !!jn.isCncl, delay: null, stops };
  },
};

/* ====================== source: Italy via the RFI arrival boards (iechub.rfi.it) ======================
 * Trenitalia's ViaggiaTreno API refuses requests from Cloudflare addresses, but the public arrival/departure monitors of the
 * infrastructure manager RFI answer. They list every train (Trenitalia, Italo, regional operators) with its delay in minutes
 * at that station, which is exactly what the alarm needs at the destination. Station ids come from the monitor's own list. */
const RFI = 'https://iechub.rfi.it/ArriviPartenze/';
const RFI_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8', 'Accept': 'text/html' };
const IT_TZ = 'Europe/Rome';
let rfiStations = null, rfiStationsAt = 0;
const unesc = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const strip = h => unesc(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
async function rfiStationList() {
  if (rfiStations && Date.now() - rfiStationsAt < 12 * 3600e3) return rfiStations;
  const r = await fetch(RFI, { headers: RFI_HEADERS, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) throw new Error('upstream HTTP ' + r.status);
  const html = await r.text();
  const list = [...html.matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)].map(m => ({ id: m[1], name: unesc(m[2]).trim(), lat: null, lon: null }));
  if (list.length > 100) { rfiStations = list; rfiStationsAt = Date.now(); }
  return list;
}
function rfiTimeToISO(hhmm, now = Date.now()) {       // board shows HH:MM in Italian local time, no date: pick the closest day
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); if (!m) return null;
  const p = localParts(new Date(now).toISOString(), IT_TZ);
  const today = localToISO(`${p.year}${p.month}${p.day}`, `${m[1].padStart(2, '0')}${m[2]}00`, IT_TZ);
  const diff = new Date(today).getTime() - now;
  if (diff < -14 * 3600e3) return new Date(new Date(today).getTime() + 86400e3).toISOString();
  if (diff > 10 * 3600e3) return new Date(new Date(today).getTime() - 86400e3).toISOString();
  return today;
}
async function rfiBoard(placeId) {
  const r = await fetch(`${RFI}ArrivalsDepartures/Monitor?placeId=${encodeURIComponent(placeId)}&arrivals=True`, { headers: RFI_HEADERS });
  if (!r.ok) throw new Error('upstream HTTP ' + r.status);
  const html = (await r.text()).replace(/<script[\s\S]*?<\/script>/g, '');
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]).filter(row => /<td/.test(row));
  return rows.map(row => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    const alt = c => (/alt="([^"]*)"/.exec(c || '') || [])[1] || '';
    const carrier = strip(cells[0] || '') || unesc(alt(cells[0])), category = (strip(cells[1] || '') || unesc(alt(cells[1]))).replace(/^Categoria\s*/i, '');
    const number = strip(cells[2] || ''), origin = strip(cells[3] || ''), time = strip(cells[4] || ''), delayTxt = strip(cells[5] || ''), track = strip(cells[6] || ''), info = strip(cells[8] || '');
    const delay = /^-?\d+$/.test(delayTxt) ? +delayTxt : null;
    const sched = rfiTimeToISO(time);
    const cancelled = /cancellat|soppress/i.test(delayTxt + ' ' + info);
    return { number, name: `${category || carrier} ${number}`.trim(), category, carrier, origin, scheduledArrival: sched, arrival: sched && delay !== null ? new Date(new Date(sched).getTime() + delay * 60e3).toISOString() : sched, delay, realTime: delay !== null, cancelled, track: track || null, info };
  }).filter(a => a.number && a.scheduledArrival);
}
const it = {
  async locations(q) {
    const list = await rfiStationList(); const n = norm(q);
    return list.filter(s => norm(s.name).includes(n)).sort((a, b) => a.name.length - b.name.length).slice(0, 12);
  },
  async arrivals(station) {
    return (await rfiBoard(station)).map(a => ({ tripId: `${station}/${a.number}`, name: a.name, category: a.category, number: a.number, origin: a.origin, operator: a.carrier, scheduledArrival: a.scheduledArrival, arrival: a.arrival, realTime: a.realTime, cancelled: a.cancelled, track: a.track }));
  },
  /* delay-only lookup: the train's current delay as shown on the destination's arrival board (appears a few hours before arrival) */
  async delay(e) {
    const n = String(e.number || '').replace(/\D/g, ''); if (!e.station || !n) return { found: false };
    const hit = (await rfiBoard(e.station)).find(a => a.number === n);
    if (!hit) return { found: false };
    return { found: true, name: hit.name, number: n, delay: hit.delay ?? 0, realTime: hit.realTime, cancelled: hit.cancelled, scheduledArrival: hit.scheduledArrival, origin: hit.origin, track: hit.track };
  },
};

/* ====================== source: MÁV Vonatinfo (delay + position only) ====================== */
const MAV = 'https://vonatinfo.mav.hu/map.aspx/getData';
async function mavTrains() {
  const r = await fetch(MAV, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Accept': 'application/json', 'User-Agent': BROWSER_UA, 'Referer': 'https://vonatinfo.mav.hu/' }, body: JSON.stringify({ a: 'TRAINS', jo: { history: false, id: false } }) });
  if (!r.ok) throw new Error('upstream HTTP ' + r.status);
  const d = await r.json();
  return d?.d?.result?.Trains?.Train || [];
}
const hu = {
  async delay(e) {
    const n = String(e.number || '').replace(/\D/g, ''); if (!n) return { found: false };
    const trains = await mavTrains();
    // MÁV numbers trains with the UIC country prefix 55 (e.g. 5512580 = train 12580); international trains may keep their number
    const hit = trains.find(t => { const tn = String(t['@TrainNumber'] || ''); return tn === n || tn === '55' + n || (tn.endsWith(n) && tn.length - n.length <= 2); });
    if (!hit) return { found: false, live: trains.length };
    return { found: true, name: String(hit['@TrainNumber']), number: n, delay: Number(hit['@Delay']) || 0, lat: Number(hit['@Lat']), lon: Number(hit['@Lon']), relation: hit['@Relation'] || '', operator: hit['@Menetvonal'] || '' };
  },
};
const SOURCES = { oebb, it, hu };

/* ====================== alarm evaluation (server copy of the app logic, no GPS) ====================== */
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
function destFromStops(stops, alarm) {
  let idx = stops.findIndex(s => s.schedArr && Math.abs(minsDiff(s.schedArr, alarm.scheduledArrival)) <= 1 && distKm(s, alarm.station) < 2);
  if (idx < 0) idx = stops.findIndex(s => s.schedArr && Math.abs(minsDiff(s.schedArr, alarm.scheduledArrival)) <= 1);
  return idx;
}
async function extInfo(e, alarm) {
  const src = SOURCES[e.src]; if (!src) return null;
  if (src.delay) {                                                   // delay-only sources (RFI boards, MÁV)
    const d = await src.delay(e); if (!d.found) return null;
    return { source: e.src, realTime: d.realTime !== false, cancelled: !!d.cancelled, schedArr: alarm.scheduledArrival, realArr: new Date(new Date(alarm.scheduledArrival).getTime() + (d.delay || 0) * 60e3).toISOString() };
  }
  if (!src.trip) return null;
  const td = await src.trip(e.tripId);
  const idx = destFromStops(td.stops, alarm); if (idx < 0) return null;
  const d = td.stops[idx];
  return { source: e.src, realTime: !!td.realTime, cancelled: !!(td.cancelled || d.cancelled), schedArr: d.schedArr, realArr: d.realArr || d.schedArr };
}
const PREFER = { AT: 'oebb', IT: 'it', HU: 'hu' };
async function evaluate(alarm) {
  const ext = alarm.ext || (alarm.oebb?.tripId ? [{ src: 'oebb', tripId: alarm.oebb.tripId }] : []);
  const jobs = [...(alarm.members || []).map(m => transitousInfo(m, alarm)), ...ext.map(e => extInfo(e, alarm))];
  const results = await Promise.allSettled(jobs);
  const infos = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (!infos.length) throw new Error(results.find(r => r.status === 'rejected')?.reason?.message || 'no trip data');
  const pref = PREFER[alarm.station?.country || ''] || 'transitous';
  const score = i => (i.realTime && !i.cancelled ? 4 : 0) + (!i.cancelled ? 2 : 0) + (i.source === pref ? 1 : 0);
  infos.sort((a, b) => score(b) - score(a));
  const best = infos[0];
  const eta = best.realTime ? best.realArr : best.schedArr;
  return { eta, schedEta: best.schedArr, delay: minsDiff(eta, best.schedArr), cancelled: best.cancelled, realTime: best.realTime, source: best.source, at: Date.now() };
}

/* ====================== push ====================== */
const MSG = {
  en: { wake: ['Arrive Awake: time to get up', 'Arrival in {dest} expected at {eta} ({delay}).'], arrived: ['Arrive Awake: arriving now', 'Your train should be arriving in {dest} now.'], cancel: ['Arrive Awake: check your train', 'Your stop {dest} is reported as cancelled.'], test: ['Arrive Awake: test', 'Notifications work. Expected arrival in {dest}: {eta} ({delay}).'] },
  de: { wake: ['Arrive Awake: Zeit zum Aufstehen', 'Ankunft in {dest} voraussichtlich um {eta} ({delay}).'], arrived: ['Arrive Awake: Ankunft jetzt', 'Dein Zug sollte jetzt in {dest} ankommen.'], cancel: ['Arrive Awake: Zug prüfen', 'Dein Halt {dest} wird als ausgefallen gemeldet.'], test: ['Arrive Awake: Test', 'Benachrichtigungen funktionieren. Erwartete Ankunft in {dest}: {eta} ({delay}).'] },
};
function fmtTime(iso, tz, lang) { try { return new Intl.DateTimeFormat(lang === 'de' ? 'de-AT' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || AT_TZ }).format(new Date(iso)); } catch (e) { return String(iso).slice(11, 16); } }
function delayStr(min, lang) { if (!Number.isFinite(min) || Math.abs(min) < 1) return lang === 'de' ? 'pünktlich' : 'on time'; return (min > 0 ? '+' : '−') + Math.abs(min) + (lang === 'de' ? ' Min' : ' min'); }
function texts(alarm, kind, ev) {
  const lang = MSG[alarm.lang] ? alarm.lang : 'en';
  const eta = ev?.eta || alarm.scheduledArrival;
  const vars = { dest: alarm.station?.name || '', eta: fmtTime(eta, alarm.station?.tz, lang), delay: delayStr(ev?.delay ?? 0, lang) };
  const [title, body] = MSG[lang][kind].map(s => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''));
  return { lang, eta, title, body };
}
async function sendPush(env, alarm, kind, ev) {
  const { lang, eta, title, body } = texts(alarm, kind, ev);
  const data = JSON.stringify({ kind, title, body, eta, delay: ev?.delay ?? null, dest: alarm.station?.name, id: alarm.id, lang, ack: alarm.api ? alarm.api + '/alarm?id=' + encodeURIComponent(alarm.id) : null });
  const vapid = { subject: env.VAPID_SUBJECT || 'mailto:admin@example.com', publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const payload = await buildPushPayload({ data, options: { ttl: 120, urgency: 'high', topic: 'arrive-awake' } }, alarm.subscription, vapid);
  const r = await fetch(alarm.subscription.endpoint, payload);
  if (r.status === 404 || r.status === 410) return 'gone';
  if (!r.ok) throw new Error('push service HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return 'sent';
}

/* ====================== optional loud alarm: Pushover emergency priority ======================
 * A web push notification plays the phone's normal notification sound once, obeys silent mode / Do Not Disturb and cannot
 * loop, so it does not wake a deep sleeper. Pushover's emergency priority is the one thing that does: it rings loudly,
 * repeats every `retry` seconds and ignores silent mode and Do Not Disturb until the user acknowledges (or `expire` passes).
 * Needs a Pushover application token as secret PUSHOVER_TOKEN (free to register) and each user's own Pushover user key. */
const PO = 'https://api.pushover.net/1/';
const validPoKey = k => typeof k === 'string' && /^[A-Za-z0-9]{30}$/.test(k);
async function poPost(path, form) {
  const r = await fetch(PO + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 1) throw new Error('Pushover: ' + ((j.errors || []).join(', ') || 'HTTP ' + r.status));
  return j;
}
async function sendLoud(env, alarm, kind, ev) {
  const { title, body } = texts(alarm, kind, ev);
  return poPost('messages.json', { token: env.PUSHOVER_TOKEN, user: alarm.pushover, title, message: body, priority: 2, retry: 30, expire: 1800, sound: 'persistent', ...(alarm.appUrl ? { url: alarm.appUrl, url_title: 'Arrive Awake' } : {}) });
}
async function cancelLoud(env, alarm) {
  if (!alarm?.poReceipt || alarm.poReceipt === 'n/a' || !env.PUSHOVER_TOKEN) return;
  try { await poPost(`receipts/${encodeURIComponent(alarm.poReceipt)}/cancel.json`, { token: env.PUSHOVER_TOKEN }); } catch (e) { /* already acknowledged or expired */ }
}
/* Web push is escalated sparingly: gaps in seconds before the n-th notification. Fewer, spaced-out notifications keep the site
 * from being classed as disruptive (Chrome revokes notification permission for high volume + low engagement). */
const PUSH_GAPS = [0, 60, 60, 120, 180, 240, 300, 300];
const pushDue = (a, now) => (a.pushCount || 0) < PUSH_GAPS.length && now - (a.lastPush || 0) >= PUSH_GAPS[a.pushCount || 0] * 1000 - 10000;

/* ====================== alarm store & cron ======================
 * KV on the Workers free plan allows 1000 writes, 1000 lists and 100k reads per day, so the cron must be frugal:
 * alarms are tracked in one index key (read, never listed), evaluation results are not written back every minute
 * (only pushes, snoozes and updates are persisted), and far-away alarms are evaluated rarely. */
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
    // cadence by time left to the scheduled alarm: > 6 h every 30 min, > 3 h every 15 min, > 1 h every 10 min,
    // last hour every minute; once pushing has started, every minute
    const toAlarm = schedMs - a.lead * 60e3 - now;
    const interval = (a.pushCount || 0) > 0 || toAlarm <= 3600e3 ? 1 : toAlarm <= 3 * 3600e3 ? 10 : toAlarm <= 6 * 3600e3 ? 15 : 30;
    if (!force && interval > 1 && new Date(now).getUTCMinutes() % interval !== 0) { log.skipped = true; out.push(log); return; }
    let ev = null;
    try { ev = await evaluate(a); } catch (e) { log.err = String(e.message || e); ev = a.last || null; }
    const etaMs = ev?.eta ? new Date(ev.eta).getTime() : schedMs;
    const alarmAt = etaMs - a.lead * 60e3;
    log.eta = new Date(etaMs).toISOString(); log.alarmAt = new Date(alarmAt).toISOString(); log.source = ev?.source;
    let kind = null, dirty = false;
    if (ev?.cancelled && !a.cancelPushed) { kind = 'cancel'; a.cancelPushed = true; dirty = true; }
    else if (now >= alarmAt && now >= (a.snoozeUntil || 0) && pushDue(a, now)) kind = now >= etaMs ? 'arrived' : 'wake';
    if (kind) {
      let sent = false;
      if (kind !== 'cancel' && a.pushover && env.PUSHOVER_TOKEN && !a.poReceipt && (a.poTries || 0) < 5) {
        a.poTries = (a.poTries || 0) + 1; dirty = true;
        try { const j = await sendLoud(env, a, kind, ev); a.poReceipt = j.receipt || 'n/a'; sent = true; log.loud = 'sent'; }
        catch (e) { log.loud = 'error: ' + e.message; a.poError = String(e.message).slice(0, 200); }
      }
      if (a.subscription) {
        try {
          const res = await sendPush(env, a, kind, ev); log.push = kind + ':' + res;
          if (res === 'gone') { if (!a.pushover) { await env.ALARMS.delete(key(id)); gone.push(id); out.push(log); return; } a.subscription = null; dirty = true; }
          else sent = true;
        } catch (e) { log.push = 'error: ' + e.message; }
      }
      if (sent) { a.pushCount = (a.pushCount || 0) + 1; a.lastPush = now; a.last = ev; dirty = true; }
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
    const cache = { 'Cache-Control': 'public, max-age=20' };
    try {
      /* live data sources: /{src}/… ; unprefixed paths stay ÖBB for older app versions */
      const m = path.match(/\/(oebb|it|hu)\/(locations|arrivals|trip|delay)$/) || (path.match(/\/(locations|arrivals|trip)$/) && ['', 'oebb', path.split('/').pop()]);
      if (m) {
        const src = SOURCES[m[1]]; const op = m[2];
        if (!src || !src[op]) return json({ error: `${m[1]} has no ${op}` }, 404, origin);
        if (op === 'locations') { const q = p.get('q'); if (!q) return json({ error: 'q required' }, 400, origin); return json(await src.locations(q), 200, origin, { 'Cache-Control': 'public, max-age=60' }); }
        if (op === 'arrivals') { const st = p.get('station'); if (!st) return json({ error: 'station required' }, 400, origin); return json(await src.arrivals(st, p.get('when'), p.get('duration'), p.get('all') === '1'), 200, origin, cache); }
        if (op === 'trip') { const id = p.get('id'); if (!id) return json({ error: 'id required' }, 400, origin); return json(await src.trip(id), 200, origin, cache); }
        if (op === 'delay') { const n = p.get('number'); if (!n) return json({ error: 'number required' }, 400, origin); return json(await src.delay({ number: n, station: p.get('station') }), 200, origin, cache); }
      }
      /* push alarm */
      if (is('/vapid')) return json({ publicKey: env.VAPID_PUBLIC_KEY || null, push: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.ALARMS), loud: !!(env.PUSHOVER_TOKEN && env.ALARMS) }, 200, origin);
      if (is('/pushover/test') && request.method === 'POST') {
        if (!env.PUSHOVER_TOKEN || !env.ALARMS) return json({ error: 'loud alarm not configured on this server' }, 503, origin);
        const b = await request.json().catch(() => ({}));
        if (!validPoKey(b.user)) return json({ error: 'Pushover user key must be 30 letters/digits' }, 400, origin);
        if (await env.ALARMS.get('potest:' + b.user)) return json({ error: 'please wait a minute between tests' }, 429, origin);
        await env.ALARMS.put('potest:' + b.user, '1', { expirationTtl: 60 });
        await poPost('messages.json', { token: env.PUSHOVER_TOKEN, user: b.user, title: 'Arrive Awake: test', message: b.lang === 'de' ? 'Der laute Wecker funktioniert. Echte Wecker klingeln mit Notfall-Priorität, bis du bestätigst.' : 'The loud alarm works. Real alarms ring with emergency priority until you acknowledge.', priority: 1, sound: 'persistent' });
        return json({ ok: true }, 200, origin);
      }
      if (is('/alarm') || is('/alarm/snooze') || is('/alarm/test')) {
        if (!env.ALARMS || !env.VAPID_PRIVATE_KEY) return json({ error: 'push alarm not configured on this server (KV + VAPID keys)' }, 503, origin);
        if (request.method === 'POST' && is('/alarm')) {
          const b = await request.json();
          if ((!b?.subscription?.endpoint && !validPoKey(b?.pushover)) || !b.scheduledArrival || !b.station) return json({ error: 'subscription (or Pushover key), station, scheduledArrival required' }, 400, origin);
          const id = String(b.id || crypto.randomUUID()).slice(0, 80);
          const prev = await env.ALARMS.get(key(id), 'json');
          const ext = Array.isArray(b.ext) ? b.ext.filter(e => e && SOURCES[e.src]).slice(0, 6) : (b.oebb?.tripId ? [{ src: 'oebb', tripId: b.oebb.tripId }] : []);
          const api = (() => { try { const u = new URL(String(b.api)); const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname); return (u.protocol === 'https:' || local) ? u.origin + u.pathname.replace(/\/+$/, '') : null; } catch (e) { return null; } })();
          const appUrl = typeof b.appUrl === 'string' && /^https:\/\/[^\s]{1,200}$/.test(b.appUrl) ? b.appUrl : null;
          const a = { id, subscription: b.subscription?.endpoint ? b.subscription : null, pushover: validPoKey(b.pushover) ? b.pushover : null, api, appUrl, poReceipt: prev?.poReceipt || null, poTries: prev?.poTries || 0, lead: Math.min(180, Math.max(1, +b.lead || 20)), lang: b.lang === 'de' ? 'de' : 'en', station: b.station, scheduledArrival: b.scheduledArrival, members: (b.members || []).slice(0, 8), ext, snoozeUntil: +b.snoozeUntil || 0, createdAt: prev?.createdAt || Date.now(), pushCount: prev?.pushCount || 0, lastPush: prev?.lastPush || 0, last: prev?.last || null };
          await env.ALARMS.put(key(id), JSON.stringify(a), { expirationTtl: ttlFor(a) });
          if (!prev) await addToIndex(env, id);
          return json({ id, ok: true }, 200, origin);
        }
        const id = p.get('id'); if (!id) return json({ error: 'id required' }, 400, origin);
        const a = await env.ALARMS.get(key(id), 'json');
        if (request.method === 'DELETE') { if (a) { await cancelLoud(env, a); await removeAlarm(env, id); } return json({ ok: true }, 200, origin); }
        if (!a) return json({ error: 'unknown alarm' }, 404, origin);
        if (is('/alarm/snooze')) { await cancelLoud(env, a); a.poReceipt = null; a.poTries = 0; a.pushCount = 0; a.snoozeUntil = +p.get('until') || Date.now() + 5 * 60e3; a.lastPush = 0; await env.ALARMS.put(key(id), JSON.stringify(a), { expirationTtl: ttlFor(a) }); return json({ ok: true, snoozeUntil: a.snoozeUntil }, 200, origin); }
        if (is('/alarm/test')) { if (!a.subscription) return json({ ok: false, result: 'no push subscription (loud alarm only)' }, 200, origin); let ev = a.last; try { ev = await evaluate(a); } catch (e) {} const res = await sendPush(env, a, 'test', ev); return json({ ok: res === 'sent', result: res, eta: ev?.eta || null, source: ev?.source || null }, 200, origin); }
      }
      if (is('/__cron') && env.DEV) return json(await runAlarms(env, true), 200, origin);
      if (is('/it/__diag')) {       // which request shapes does the RFI site accept from this network?
        const variants = { rfi: RFI_HEADERS, browserish: { ...RFI_HEADERS, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Referer': RFI, 'Upgrade-Insecure-Requests': '1' }, minimal: { 'User-Agent': RFI_HEADERS['User-Agent'] }, star: { ...RFI_HEADERS, 'Accept': '*/*' } };
        const out = {};
        for (const [name, h] of Object.entries(variants)) for (const u of [RFI, RFI + 'ArrivalsDepartures/Monitor?placeId=2416&arrivals=True']) {
          try { const r = await fetch(u, { headers: h }); out[name + ' ' + u.slice(-40)] = r.status + ' ' + (r.headers.get('cf-mitigated') || ''); } catch (e) { out[name + ' ' + u.slice(-40)] = 'error ' + e.message; }
        }
        return json(out, 200, origin);
      }
      return json({ ok: true, service: 'arrive-awake backend', sources: Object.keys(SOURCES), push: !!(env.VAPID_PUBLIC_KEY && env.ALARMS), endpoints: ['/{oebb|it}/locations?q=', '/{oebb|it}/arrivals?station=&when=&duration=', '/oebb/trip?id=', '/it/delay?station=&number=', '/hu/delay?number=', '/vapid', 'POST /alarm', 'DELETE /alarm?id=', 'POST /alarm/snooze?id=&until=', 'POST /alarm/test?id=', 'POST /pushover/test'] }, 200, origin);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, origin);
    }
  }
};
