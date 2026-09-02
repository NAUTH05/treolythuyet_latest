# Treo Hoc Ly Thuyet

Web Dashboard and CLI for Playwright-based lesson sessions.

## Architecture

Firestore is the persistent source of truth through the Firebase Admin SDK. Accounts, presets, queues, and Auto-Scan state are stored in these documents:

- `system_accounts/list`
- `system_presets/list`
- `system_autoscan_presets/list`
- `system_queues/state`
- `system_autoscan/state`

The application does not require `accounts.json` or any other local JSON database. Runtime logs, Playwright files, and deployment artifacts may still use the filesystem. If Firestore is unavailable, the server reports the failure and does not load stale local application state.

## Configuration

Copy `.env.example` to `.env` and set a strong admin password and a credential path outside the repository:

```powershell
Copy-Item .env.example .env
notepad .env
```

Example:

```env
PORT=3000
ADMIN_PASSWORD=replace-with-a-long-random-password
FIREBASE_SERVICE_ACCOUNT_FILE=C:\Secure\TreoWeb\firebase-service-account.json
```

Never commit `.env` or a Firebase service-account JSON file. Credentials are server-side only and are never accepted through the Dashboard API.

## Install and run

```powershell
npm ci
npm run build
npm run install-browser
npm run verify:firebase-admin
npm start
```

Open `http://localhost:3000/lythuyet`.

## CLI

```powershell
node index.js --url https://example.invalid/slides/slide/lesson --time 240 --account all
```

The CLI also loads accounts from Firestore and fails clearly when Firestore cannot be reached.

## PM2 on Linux/VPS

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 status
pm2 logs treoweb
pm2 save
pm2 startup
```

## Existing Linux/VPS reverse proxy

Keep the `/lythuyet` route and Socket.IO upgrade headers:

```nginx
location /lythuyet {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
```

## Validation

```powershell
npm test
npm run build
npm run verify:firebase-admin
```

Run `npm run lint` when that script is available in the deployment checkout.
