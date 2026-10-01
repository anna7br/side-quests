# Arrive Awake

A mobile-first web app (PWA) that wakes you a chosen number of minutes before your train's **real**, delay-adjusted arrival, instead of at a fixed clock time. Built for night trains: pick your destination, pick your train, set "20 min before", go to sleep.

English (primary) and German, auto-detected from the phone, switchable in the header.

Live app: https://anna7br.github.io/side-quests/arrive-awake/ (install it to the home screen). Part of the [side-quests](https://github.com/anna7br/side-quests) repository.

## How it works

1. **Destination station** – searched via Transitous geocoding (all of Europe).
2. **Train** – arrivals at that station around your planned time; duplicates from different data feeds are grouped and all of them are polled.
3. **Alarm** – lead time (3–90 min). While armed the app polls every 1–10 minutes (more often as the alarm nears), recomputes
   `alarm = expected arrival − lead`, and rings with sound, vibration and a notification. "Snooze 5 min" and a safety ring at the actual arrival are included. The armed state survives a page reload.
4. **Server alarm (optional, recommended)** – with the backend deployed, the armed alarm is also stored on the server. A cron job re-evaluates the arrival every minute and sends **Web Push notifications** at alarm time, repeated every minute until you tap "I'm awake" (max 20). This is what rings when the phone is locked and the page is frozen.

Expected arrival is taken from, in order of trust:

| Source | Covers | Notes |
|---|---|---|
| **Transitous** (api.transitous.org, MOTIS) | Timetables for all of Europe; live delays where operators publish GTFS-RT: DB long-distance and regional (Germany, DELFI feed), SBB/all Swiss operators, Flix, many others. Nightjets running through Germany or Switzerland carry live data for their whole run. | Free, no key, CORS open. Non-commercial, open-source use only; identify yourself (footer attribution). Best effort, no SLA. |
| **ÖBB Scotty via your own backend** (`proxy/`) | Live delays for every operator in Austria (ÖBB, WESTbahn, GySEV/Raaberbahn, private railways) and most cross-border trains. | ÖBB publishes no open realtime feed; the ÖBB app backend (HAFAS) does answer, but browsers cannot call it directly, so a small Cloudflare Worker forwards three read-only requests. Unofficial API – keep volume personal. |
| **GPS estimate** (optional, on-device) | Anywhere | Projects the phone position onto the route and interpolates the timetable, giving a delay estimate when no live data exists or when live data looks stale. Position is never sent anywhere. |

If GPS and live data disagree by 5 min or more, GPS wins and the screen says so. Cancellation of your stop triggers an immediate alarm.

## Does it ring with the screen locked?

Only through the **server alarm**. A web page cannot run while the phone is locked, so the app itself can only ring while it is in the foreground with the screen on. With the backend deployed:

- **Android (Chrome, installed or not)**: push notifications arrive with the screen locked, make sound and vibrate (the service worker uses a long vibration pattern and `requireInteraction`). One notification per minute until acknowledged. Tapping it opens the app, which then rings continuously.
- **iPhone (iOS 16.4+)**: Web Push works **only for apps added to the home screen**, and notifications are shown with the default sound. They cannot bypass Focus modes.
- **Do Not Disturb / Sleep Focus silences normal notifications on both platforms.** Before a night train either turn it off, or allow the browser (Android: Settings → Notifications → Do Not Disturb → Apps → Chrome; iOS: Sleep Focus → Allowed apps → the home-screen app) to break through. Also exempt Chrome from battery optimisation on aggressive Android skins.
- Use **"Test push"** on the armed screen, then lock the phone, and check that the notification arrives. Do this once at home, not in the sleeper.

A native Android app with an exact alarm would be more reliable; this is the most a web app can do.

## Run locally

```bash
python -m http.server 8765 --directory .
cd proxy && npm install && npm run keys -- mailto:you@example.com && npm run dev   # backend on http://127.0.0.1:8787
```

Open http://localhost:8765, expand "Live data for Austria" and paste `http://127.0.0.1:8787`. `GET /__cron` runs the alarm check by hand in dev.

## Deploy

**App**: GitHub Pages from the `main` branch (root). HTTPS is required for the service worker, wake lock, notifications, push and geolocation.

**Backend** (Cloudflare Workers free tier is plenty: a cron trigger per minute, a KV namespace, a few hundred requests a night):

```bash
cd proxy
npm install
npx wrangler login
npx wrangler kv namespace create ALARMS        # paste the printed id into wrangler.toml
npm run keys -- mailto:you@example.com         # prints the three secrets
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler deploy
```

The app ships with the deployed backend URL as default (`DEFAULT_PROXY` in `index.html`, currently `https://arrive-awake-oebb-proxy.arrive-awake-oebb-proxy.workers.dev`); a different URL can be entered under "Live data for Austria". The "Server alarm" option is available whenever a backend URL is set. Optionally set `ALLOWED_ORIGIN` in `wrangler.toml` to `https://anna7br.github.io`.

Without the backend the app still works with Transitous live data and GPS, but only in the foreground.

## Limitations you should know before trusting it on a night train

- **Foreground only without the backend.** Keep the app in the foreground with the screen on (the app requests a wake lock; dim the screen manually and put the phone face down on the charger). The alarm sound plays through an `<audio>` element so the iOS mute switch does not silence it.
- **No signal, no update.** In tunnels or dead zones the last known times are shown and the alarm still fires on them; the warning turns red after 15 minutes without fresh data. The GPS estimate keeps working with the last fix. The server alarm needs the phone to have *some* data connection at alarm time to receive the push.
- **Transitous realtime coverage** depends on operators. Austria (outside Styria) has none without the backend. Check the dot and the source line on the armed screen: green = live data for this train.
- **Times are shown in the station's local time zone.** The ÖBB proxy assumes Europe/Vienna for board queries; stations in other time zones may be off by the zone difference in the train-matching step; the live stop times themselves are correct.
- **Train matching between feeds** uses train number and scheduled arrival. Coupled trains (two numbers, one physical train) are grouped on purpose.

## Files

```
index.html             app (single file: UI, i18n, logic)
manifest.webmanifest   PWA manifest
sw.js                  service worker (app shell cache, push notifications)
icon.svg, icon-*.png   icons
proxy/worker.js        Cloudflare Worker: ÖBB Scotty → JSON (/locations, /arrivals, /trip) + push alarm (/vapid, /alarm…)
proxy/dev-server.mjs   runs the worker locally under Node (in-memory KV, local cron)
proxy/gen-vapid-keys.mjs  VAPID key generator
proxy/wrangler.toml    deploy config (cron trigger, KV binding)
```

## Research notes (October 2026)

Existing apps found: WakeStop, TrainWake, Sleep&Arrive, WakeMeHere, Dozy, Nap Alarm. All of them are **GPS/location-based** (alarm when you get within X km of the stop); none uses operator realtime data or targets a lead time before the *predicted* arrival. DB Navigator and ÖBB apps push delay notifications but have no alarm. So this combination (live ETA − lead time, with GPS as fallback) did not exist as a ready product.

Data access checked:
- `api.transitous.org` – works, CORS, live for DB/SBB and others; no ÖBB live.
- `v6.db.transport.rest` (DB, incl. ÖBB delays via DB's data) – was returning HTTP 503 during development; would be a drop-in second source if it comes back.
- `fahrplan.oebb.at/bin/mgate.exe` (ÖBB Scotty HAFAS) – works, live for ÖBB + WESTbahn + others, no CORS → proxy.
- ÖBB Open Data (data.oebb.at) – static GTFS and weekly delay CSVs only, no GTFS-RT. Styria (Verbundlinie) is the only Austrian GTFS-RT in Transitous.
