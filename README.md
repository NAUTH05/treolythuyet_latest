# Treo Hoc Ly Thuyet - Windows Server

This branch is the Windows Server deployment edition. Core application logic is unchanged from the fixed Firestore-first version: Firestore is the persistent source of truth for accounts, presets, queues, and Auto-Scan state. No `accounts.json` or local application database is used.

## Requirements

- Windows Server 2019 or later
- Node.js LTS (64-bit)
- Git for Windows
- npm (included with Node.js)
- A Firebase service account with Firestore access
- PowerShell 5.1 or PowerShell 7

## Installation

Run PowerShell as the service account or deployment administrator:

```powershell
New-Item -ItemType Directory -Force C:\Apps\treolythuyet_latest | Out-Null
Set-Location C:\Apps
git clone -b dev-windows https://github.com/NAUTH05/treolythuyet_latest treolythuyet_latest
Set-Location C:\Apps\treolythuyet_latest
npm ci
npm run build
npm run install-browser
```

Playwright downloads Chromium for the current user. Run the install command under the same Windows account that PM2 will use.

## Credentials and .env

Keep the Firebase key outside Git:

```powershell
New-Item -ItemType Directory -Force C:\Secure\TreoWeb | Out-Null
# Copy the downloaded key to C:\Secure\TreoWeb\firebase-service-account.json
Copy-Item C:\Path\To\firebase-service-account.json C:\Secure\TreoWeb\firebase-service-account.json
Copy-Item .env.example .env
notepad .env
```

Set Windows paths in `.env`:

```env
NODE_ENV=production
PORT=3000
ADMIN_PASSWORD=replace-with-a-long-random-password
FIREBASE_SERVICE_ACCOUNT_FILE=C:\Secure\TreoWeb\firebase-service-account.json
```

Restrict the credential file to the service account and administrators using NTFS permissions. Do not commit `.env` or the JSON key.

Verify the server-side Admin SDK before starting:

```powershell
npm run verify:firebase-admin
```

## Start and PM2

```powershell
npm install -g pm2
pm2 start ecosystem.config.js
pm2 status
pm2 logs treoweb
pm2 save
```

`ecosystem.config.js` reads deployment paths from environment variables and does not contain a user-specific Windows path. Load `.env` before starting PM2, or set the variables in the account's environment:

```powershell
$env:FIREBASE_SERVICE_ACCOUNT_FILE = 'C:\Secure\TreoWeb\firebase-service-account.json'
$env:ADMIN_PASSWORD = 'replace-with-a-long-random-password'
$env:PORT = '3000'
pm2 startOrReload ecosystem.config.js --update-env
pm2 save
```

For reboot persistence, configure a Windows Task Scheduler task that runs at startup under the same service account. The action should be:

```text
Program: C:\Program Files\nodejs\pm2.cmd
Arguments: resurrect
Start in: C:\Apps\treolythuyet_latest
```

Set the task to run whether the user is logged on or not and grant it the required Playwright desktop/session permissions. After a reboot, confirm with `pm2 status` and `pm2 logs treoweb`.

## Dashboard and CLI

Open `http://localhost:3000/lythuyet` or the server hostname. The CLI also reads accounts from Firestore:

```powershell
node index.js --url https://example.invalid/slides/slide/lesson --time 240 --account all
```

If Firestore is unavailable, the application fails clearly and never falls back to stale local state.

## Validation

```powershell
npm test
npm run build
npm run verify:firebase-admin
```

There is no `npm run lint` script in this repository. Runtime logs and Playwright/browser files may use the filesystem; persistent application data remains in Firestore.

## Optional reverse proxy

On Windows, place IIS, ARR, or another reverse proxy in front of Node.js and forward `/lythuyet` to `http://127.0.0.1:3000`. Preserve WebSocket upgrade support for `/lythuyet/socket.io` and use long proxy timeouts for active sessions.

## Existing Linux/VPS VHost configuration

The original Linux deployment remains supported on the fixed application branch:

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
