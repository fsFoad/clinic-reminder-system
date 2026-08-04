# clinic-reminder-system

Multi-channel appointment reminder system (SMS via **SMS.ir** + Bale stub; extensible later).

Timestamps are stored in UTC. Display in `Asia/Tehran` in the app.

## Setup

1. Set `DATABASE_URL` in `.env` (see `.env.example`)
2. Configure SMS.ir keys in `.env` (never commit real secrets):
   - `SMSIR_API_KEY`
   - `SMSIR_LINE_NUMBER` (demo line `30002108030582` is **promotional** — for development/demo only)
   - `SMSIR_BASE_URL=https://api.sms.ir/v1`
3. `yarn install` (or `npm install`)
4. `npm run migrate && npm run db:seed`
5. `npm start` (API on `PORT`, default 3000)

Front (`clinic-reminder-front`): set `useClinicMock: false` and run `npm start` (proxies `/api/*` to `:3000`).

### SMS.ir caveats

- Auth header: `x-api-key` (not logged).
- **Promotional line**: messages to blacklisted numbers fail (`messageIds` entry `0`). Production needs a **service line** (9000 / 998).
- **No webhook**: inbound replies are polled with `GET /receive/latest` (each message returned once). Interval: `SMSIR_POLL_MS` (default 300000 = 5 min), toggle with `SMSIR_POLL_ENABLED`.
- Optional delivery refresh via `GET /send/pack/{packId}` (`SMSIR_DELIVERY_POLL_ENABLED`).
- Live SMS via **POST `/send/likeToLike`** (`messageTexts` + `mobiles` parallel arrays). Legacy `/send/bulk` remains in the client but reminders use likeToLike.
- Docs sample pack `2b99e63c-…` / messageIds `86522023` is **rejected** — never treated as success.
- Auth header: `X-API-KEY` only (do not send duplicate `x-api-key`).
- Set `SMSIR_DRY_RUN=true` to fake sends without calling the API.
- Live one-shot: `SMSIR_SMOKE_MOBILE=09… yarn smsir:smoke` (logs include `traceId`).
- Remind API returns `traceId` + header `X-Trace-Id` — grep server logs by that UUID.

## Scripts

| Script | Purpose |
|--------|---------|
| `yarn start` | HTTP API on `PORT` (default 3000) |
| `yarn migrate` | Apply DB migrations |
| `yarn db:seed` | Load sample data |
| `yarn test:parser` | Unit-test reply parsing |
| `yarn test:smsir` | Mocked SMS.ir client + mobile normalize tests |
| `yarn smsir:smoke` | Optional live send (requires `SMSIR_SMOKE_MOBILE`) |
| `yarn test:db` | DB connection smoke test |

## Schedulers

| Env | Default | Purpose |
|-----|---------|---------|
| `REMINDER_CRON_ENABLED` / `REMINDER_CRON_MS` | on / 60s | Due outbound reminders (`processDueReminders`) — SMS goes through SMS.ir |
| `SMSIR_POLL_ENABLED` / `SMSIR_POLL_MS` | on / 5min | Inbound SMS poll + pack delivery updates |

Manual triggers:

- `POST /api/cron/reminders`
- `POST /api/cron/smsir-inbound`
- `POST /api/cron/fallbacks`

## API (skeleton)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check (+ SMS.ir configured flags, no secrets) |
| GET | `/api/import/template.xlsx` | Excel import template |
| POST | `/api/import/preview` | Preview Excel/PDF rows (`multipart file` + `mode`) |
| POST | `/api/import/commit` | Commit selected import rows |
| GET | `/api/appointments/summary` | Dashboard view |
| GET | `/api/appointments/pending-no-response?hours=4` | Fallback candidates |
| POST | `/api/appointments/:id/remind` | Send reminder (real SMS.ir when channel=sms) |
| POST | `/api/cron/fallbacks` | Run Bale→SMS fallback pass |
| POST | `/api/cron/reminders` | Run due reminders once |
| POST | `/api/cron/smsir-inbound` | Poll SMS.ir inbox once |
| POST | `/api/webhooks/inbound` | Patient reply webhook (still usable for Bale/dev) |
| POST | `/api/webhooks/delivery` | Delivery status webhook |
| POST | `/api/dev/parse` | Dry-run parse `{ "content": "تایید شود" }` |

Import modes: `patient_and_appointment` | `patients_only` | `appointments_only`

Patient reply keywords:

- Locked (clinic / Bale): `تایید شود` / `جابجا شود` / `کنسل شود`
- SMS short replies also accepted: `1`/`لغو`/`cancel`/`نمیام` → cancel; `2`/`تایید`/`میام`/`ok`/`باشه` → confirm

Outbound SMS appends a short `۱`/`۲` footer in addition to the locked keyword footer.

## Clinic settings (per user)

Settings live in Postgres table `clinic_settings`, keyed by `user_id` (text).

- Front sends `Authorization: Bearer mock-{userId}` (same token as SessionStore).
- Backend middleware `attachUser` sets `req.userId` from that header (fallback: `DEFAULT_SETTINGS_USER_ID`, default `1`).
- First `GET /api/settings/clinic` for a user seeds defaults; users are isolated.
- One-time optional migrate: if `data/clinic-settings.json` exists and user `LEGACY_SETTINGS_USER_ID` (default `2` = admin) has no row, JSON is imported once. After that the JSON file is legacy only.
- Cron (`processDueReminders`) loops every user with a settings row and scopes appointments by that `user_id`.
- Inbound SMS matching uses `patient_channel_identities.user_id` for tenant isolation.
