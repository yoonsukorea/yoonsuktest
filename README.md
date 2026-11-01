# yoonsuktest
윤석 프로젝트 테스트

## Toss Securities account and stock data

The existing app uses the read-only Toss Securities Open API for Korean and
U.S. stock quotes, USD/KRW exchange rates, and the signed-in owner's brokerage
account and holdings. It does not expose order or trading endpoints. Manual
Kiwoom holdings and imported Toss holdings are stored separately in the user's
existing Supabase household document; quote credentials remain server-side.

### Local setup

1. Install Node.js 20.6 or newer.
2. Copy `.env.example` to `.env` and set `TOSS_CLIENT_ID` and
	`TOSS_CLIENT_SECRET`. Never commit `.env` or put these values in `index.html`.
3. Set `TOSS_ALLOWED_USER_ID` to the UUID of the one Supabase Auth user allowed
	to view the connected Toss account. Find it in Supabase **Authentication →
	Users**. This server-side allowlist prevents other household sign-ins from
	seeing the brokerage account.
4. In the Toss Securities WTS, register the server's outbound IP under the
	Open API allowed-IP settings. Local development may use a changing IP, so a
	deployed server with a stable outbound IP is recommended.
5. Start the server with `node --env-file=.env server.mjs`.
6. Open `http://localhost:8000`.

For deployment, run `server.mjs` on a Node.js host that supports private
environment variables and serves the app from the same origin. GitHub Pages
cannot run this API proxy; do not put Toss credentials in the public repository.

The UI requests quotes immediately on page load and every 30 seconds while the
page is open. It displays the quote timestamp returned by Toss. The official
API documents a price timestamp but do not state a guaranteed delay in the
overview, so the app does not promise exchange-grade real-time delivery. When
quotes are unavailable, existing holdings and the last saved quote remain
visible. U.S. prices use the Toss USD/KRW reference rate for won conversion.
The asset view's connection test checks OAuth, Samsung Electronics (`005930`),
Apple (`AAPL`), and the exchange rate. Authenticated account lookup uses
`GET /api/v1/accounts`; holdings use `GET /api/v1/holdings` with the selected
`X-Tossinvest-Account` value. Account and holdings requests require the
Supabase session and the matching `TOSS_ALLOWED_USER_ID`.

## Supabase login and cloud sync

The app supports email/password Supabase Auth and syncs each signed-in user's
complete household state as one revisioned JSON document. Row-level security
restricts reads and writes to `auth.uid()`. Realtime database changes are
subscribed for updates on other devices. Concurrent edits are merged by record
ID; conflicting edits are rejected rather than silently overwriting one
another, and the local snapshot remains available.

To configure a Supabase project:

1. In Supabase **SQL Editor**, run the contents of [`supabase-schema.sql`](./supabase-schema.sql).
2. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`) as
   server environment variables. These are the project URL and public anon /
   publishable key, never the `service_role` secret.
3. Add the deployed HTTPS origin to Supabase **Authentication → URL
   Configuration → Site URL and Redirect URLs**.
4. Open the app and create/sign in to the email account. On a new cloud account,
   choose the one-time migration action. The app downloads a full JSON backup
   before inserting the existing local state, then reads it back and verifies
   the full document, record counts, and amount totals. The local browser state
   is not deleted. A unique account row prevents a second import from
   overwriting existing cloud data.

The repository does not contain project credentials. Until the server
environment variables are configured and the SQL is applied, the app clearly
reports local-only mode and does not claim that cloud sync or login is active.

Use **백업 내보내기** before changing devices or browser storage. The exported
JSON includes the full app state. **백업 복원** requires confirmation; when
signed in it queues the restored data for revision-checked cloud saving.

The app includes a web app manifest and service worker for installable use on
supporting browsers. Installation requires HTTPS (or localhost); the service
worker caches the app shell only and does not cache API responses or synchronize
private data.

Production readiness still requires configuring the Supabase Site URL /
redirect URL, setting the authorized Supabase user UUID, and registering the
Render server's actual outbound IP in Toss Securities Open API settings. API
credentials and the user allowlist are private Render environment values.

## Render deployment

The [`render.yaml`](./render.yaml) Blueprint runs this existing app from
`server.mjs`; it does not create a replacement app. The build command is
`node --check server.mjs && node --check service-worker.js` and the start
command is `node server.mjs`. Render supplies the `PORT` environment variable.
The `/healthz` route is a health check, and `/` and `/index.html` serve the same
existing `index.html`.

Before creating or switching to the Render URL, download and verify a JSON
backup from the browser origin that currently contains your budget records.
Browser local storage is isolated by domain, so a new Render origin cannot see
the Codespaces origin's records. Keep using the original URL until the backup
has been verified and imported into your authenticated Supabase account. In
Render, connect the existing `yoonsukorea/yoonsuktest` repository and select
**Blueprint** / `render.yaml`; provide `SUPABASE_URL` and
`SUPABASE_ANON_KEY`, `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`, and
`TOSS_ALLOWED_USER_ID` as private environment values. Do not add a service-role
key. Configure the resulting `https://<service>.onrender.com` address as the
Supabase Auth Site URL and an allowed Redirect URL. Deploying itself cannot
configure a Supabase project or move browser-local records.
