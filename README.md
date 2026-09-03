# Treo Ly Thuyet

Linux VPS deployment guide for the test_dev branch.

Public URL: https://lythuyet.mrnauthdev.dpdns.org

Do not use /lythuyet as the public URL.

## Overview

This repository contains a Node.js/Express dashboard, React/Vite client, Playwright Chromium lesson automation, Firebase Admin/Firestore persistence, Socket.IO live updates, and a CLI.

## Features

- Dashboard for accounts, queues, sessions, Auto-Scan, presets, and logs.
- Headless Playwright Chromium sessions.
- Admin password authentication with bearer tokens.
- Firestore-backed persistent state.
- Socket.IO status and log events.
- CLI via node index.js.

## Architecture

~~~text
Internet
  -> lythuyet.mrnauthdev.dpdns.org
  -> Nginx :80/:443
  -> Node.js 127.0.0.1:3000 (PORT may override)
  -> Firebase Admin/Firestore and lesson site
~~~

The source requires internal paths /lythuyet/, /lythuyet/api/*, and /lythuyet/socket.io. Nginx maps the domain root to the internal dashboard path while preserving those paths. The browser-facing endpoint remains the bare domain.

## Requirements

- Ubuntu 22.04/24.04 LTS or supported Debian stable.
- Node.js 20 LTS recommended. Dependencies require Node.js >=18; the repository has no engines field. npm 10.x is bundled with Node 20.
- Git, Nginx, PM2, UFW, Certbot, and DNS tools.
- Playwright Chromium and Linux libraries.
- Firebase Admin credentials and Firestore access.
- DNS control for lythuyet.mrnauthdev.dpdns.org.
- Outbound HTTPS; inbound 22/80/443.
- At least 2 GB RAM is a practical starting point; concurrency determines actual capacity.

## Linux VPS Preparation

~~~bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl git nginx ufw dnsutils certbot python3-certbot-nginx
~~~

## Install Git

~~~bash
git --version
~~~

## Install Node.js

~~~bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
~~~

Expected major versions: Node 20.x and npm 10.x.

## Clone Repository

~~~bash
cd /opt
sudo git clone https://github.com/NAUTH05/treolythuyet_latest.git treolythuyet
sudo chown -R "$USER":"$USER" /opt/treolythuyet
cd /opt/treolythuyet
~~~

## Checkout test_dev

~~~bash
git checkout test_dev
git branch --show-current
git log -1 --oneline
~~~

Expected branch output is test_dev. Never deploy, merge, rebase, or reset main on this VPS.

## Install Dependencies

Both lockfiles are required:

~~~bash
npm ci
cd client && npm ci && cd ..
~~~

npm ci reproduces the locked dependency tree. Do not delete or regenerate lockfiles during deployment.

## Install Playwright

The source launches Chromium. Install its Linux libraries and browser:

~~~bash
npx playwright install-deps chromium
npm run install-browser
~~~

The script runs npx playwright install chromium. The launcher is headless and uses --no-sandbox, --disable-setuid-sandbox, and --disable-dev-shm-usage.

## Firebase Configuration

Firebase Admin is initialized server-side. Confirmed persistent documents:

| Collection | Document |
| --- | --- |
| system_accounts | list |
| system_presets | list |
| system_autoscan_presets | list |
| system_queues | state |
| system_autoscan | state |
| system_logs | latest and daily documents |
| system_logs_daily | daily account documents |
| system_settings | admin_sdk_verification |

Keep a service-account JSON outside Git:

~~~bash
sudo install -d -m 750 /etc/treolythuyet
sudo install -m 640 /path/you/received/firebase-service-account.json /etc/treolythuyet/firebase-service-account.json
sudo chown root:"$USER" /etc/treolythuyet/firebase-service-account.json
~~~

The JSON must contain project_id, client_email, and private_key. The deployment user must be able to read it; mode 640 with group set to that user is sufficient.

## Environment Configuration

~~~bash
cp .env.example .env
nano .env
chmod 600 .env
~~~

| Variable | Required | Meaning |
| --- | --- | --- |
| NODE_ENV | Recommended | Use production. |
| PORT | Optional | Listen port; defaults to 3000. |
| ADMIN_PASSWORD | Required for dashboard login | Strong admin password. |
| FIREBASE_SERVICE_ACCOUNT_FILE | Recommended | Absolute credential JSON path. |
| GOOGLE_APPLICATION_CREDENTIALS | Alternative | Credential JSON path if the previous variable is absent. |
| FIREBASE_SERVICE_ACCOUNT_JSON | Alternative | Complete credential JSON string. |
| FIREBASE_SERVICE_ACCOUNT_BASE64 | Alternative | Base64 credential JSON. |
| FIREBASE_PROJECT_ID | Conditional | Project ID for direct credentials or ADC. |
| FIREBASE_CLIENT_EMAIL | Conditional | Direct service-account client email. |
| FIREBASE_PRIVATE_KEY | Conditional | Direct service-account private key; use \n escapes. |
| FIREBASE_USE_APPLICATION_DEFAULT | Conditional | true, 1, or yes only when ADC is provided. |
| GOOGLE_CLOUD_PROJECT | Conditional | ADC project ID fallback. |

The checked-in .env.example uses NODE_ENV, PORT, ADMIN_PASSWORD, FIREBASE_SERVICE_ACCOUNT_FILE, and FIREBASE_USE_APPLICATION_DEFAULT. Choose one credential method. Never commit .env or credentials.

Example:

~~~env
NODE_ENV=production
PORT=3000
ADMIN_PASSWORD=replace-with-a-long-random-password
FIREBASE_SERVICE_ACCOUNT_FILE=/etc/treolythuyet/firebase-service-account.json
FIREBASE_USE_APPLICATION_DEFAULT=false
~~~

## File Permissions

Runtime writes are:

- PM2 logs: logs/error.log and logs/output.log.
- Daily logs: logs/daily/DD-MM-YYYY/logs.json.
- Legacy/local daily log compatibility: daily-logs.json.

Firestore-backed state uses filePath: null in this branch, so those stores do not require local JSON files.

~~~bash
mkdir -p /opt/treolythuyet/logs/daily
sudo chown -R "$USER":"$USER" /opt/treolythuyet
chmod 750 /opt/treolythuyet /opt/treolythuyet/logs /opt/treolythuyet/logs/daily
~~~

Never use chmod -R 777.

## Build Application

~~~bash
npm run build
~~~

This runs cd client && npm run build and writes Vite output to public/, which Express serves at internal /lythuyet/.

## Verify Installation

~~~bash
npm run verify:firebase-admin
~~~

This verifies Firestore connectivity, reads persistent documents, writes and reads back system_settings/admin_sdk_verification, and should report that read/write verification passed.

## Run Manually

~~~bash
npm start
~~~

Default local endpoint:

~~~bash
curl -I http://127.0.0.1:3000/lythuyet/
~~~

There is no dedicated /health endpoint. Stop with Ctrl+C.

CLI example:

~~~bash
node index.js --url https://example.invalid/slides/slide/lesson --time 240 --account all
~~~

## PM2 Deployment

~~~bash
npm install -g pm2
cd /opt/treolythuyet
pm2 start ecosystem.config.js
pm2 status
pm2 logs treoweb
pm2 restart treoweb
pm2 stop treoweb
pm2 delete treoweb
pm2 monit
~~~

The exact PM2 name is treoweb; the checked-in config runs server.js, autorestarts, and writes the two PM2 log files.

## PM2 Startup After Reboot

~~~bash
pm2 save
pm2 startup
~~~

Execute the command printed by pm2 startup. Then reboot and verify:

~~~bash
sudo reboot
# after reconnecting
pm2 status
sudo systemctl status nginx --no-pager
~~~

## DNS Configuration

Create an A record:

~~~text
lythuyet.mrnauthdev.dpdns.org -> VPS public IP
~~~

Verify:

~~~bash
dig lythuyet.mrnauthdev.dpdns.org
nslookup lythuyet.mrnauthdev.dpdns.org
~~~

## Nginx Reverse Proxy

~~~bash
sudo nano /etc/nginx/sites-available/lythuyet.mrnauthdev.dpdns.org
~~~

For PORT=3000:

~~~nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    listen [::]:80;
    server_name lythuyet.mrnauthdev.dpdns.org;

    # Source requires /lythuyet/ internally; public URL remains /.
    location = / {
        proxy_pass http://127.0.0.1:3000/lythuyet/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # Preserve /lythuyet/assets, /lythuyet/api, and /lythuyet/socket.io.
    location /lythuyet/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
~~~

The internal location exists because the source explicitly requires it; it is not the public URL. If PORT changes, replace both 3000 values.

Enable and test:

~~~bash
sudo ln -s /etc/nginx/sites-available/lythuyet.mrnauthdev.dpdns.org /etc/nginx/sites-enabled/lythuyet.mrnauthdev.dpdns.org
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
~~~

## Domain Configuration

Use the exact hostname lythuyet.mrnauthdev.dpdns.org. Do not configure the deployment as a public subdirectory.

## HTTPS / SSL

After DNS resolves and Nginx is reachable:

~~~bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d lythuyet.mrnauthdev.dpdns.org
sudo certbot renew --dry-run
~~~

Allow the HTTP-to-HTTPS redirect when prompted. Certbot modifies Nginx.

## Firewall

Preserve SSH before enabling UFW:

~~~bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status verbose
~~~

Public ports are 22, 80, and 443. Do not expose Node's port.

## Health Checks

~~~bash
pm2 status
curl -I http://127.0.0.1:3000/lythuyet/
sudo nginx -t
curl -I http://lythuyet.mrnauthdev.dpdns.org
curl -I https://lythuyet.mrnauthdev.dpdns.org
~~~

HTTP may redirect to HTTPS. Open exactly https://lythuyet.mrnauthdev.dpdns.org, sign in, and confirm dashboard data plus a Socket.IO WebSocket/polling connection at /lythuyet/socket.io.

## Testing

Root scripts:

- npm test: Node built-in test suite.
- npm run build: client build.
- npm run verify:firebase-admin: Firebase Admin read/write verification.
- npm run install-browser: Chromium installation.
- npm start and npm run dev: start server.js.
- npm run cli: CLI entry (requires arguments).
- npm run dev:client: Vite dev server on 5173.
- npm run setup: install/build/browser setup.

Client scripts:

~~~bash
cd client
npm run lint
npm run build
npm run preview
cd ..
~~~

There is no root npm run lint.

## Updating test_dev

~~~bash
cd /opt/treolythuyet
git fetch origin
git checkout test_dev
git pull --ff-only origin test_dev
npm ci
cd client && npm ci && cd ..
npm run install-browser
npm run build
npm test
pm2 restart treoweb
~~~

Never switch to or merge main.

## Rollback

~~~bash
git log --oneline --decorate -20
git log -1 --oneline
pm2 stop treoweb
git checkout <previous-test-dev-commit>
npm ci
cd client && npm ci && cd ..
npm run build
pm2 start treoweb
~~~

This checks out a detached commit. Return with git checkout test_dev. Avoid git reset --hard because it discards uncommitted files.

## Logs

~~~bash
pm2 logs
pm2 logs treoweb
tail -f /opt/treolythuyet/logs/output.log
tail -f /opt/treolythuyet/logs/error.log
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
~~~

## Troubleshooting

### Application does not start

Run pm2 status and pm2 logs treoweb, check .env, and ensure public/index.html exists.

### Port already in use

~~~bash
sudo ss -ltnp | grep :3000
~~~

Use the configured PORT and update both Nginx targets if it changes.

### Firebase initialization failure

Check credentials, path, permissions, project/network access, then run npm run verify:firebase-admin and inspect PM2 logs.

### Playwright failure

~~~bash
npx playwright install-deps chromium
npm run install-browser
~~~

Check disk, executable permissions, and PM2 logs.

### Nginx 502

~~~bash
pm2 status
curl -I http://127.0.0.1:3000/lythuyet/
sudo nginx -t
sudo tail -f /var/log/nginx/error.log
~~~

### WebSocket / Socket.IO failure

Check HTTP/1.1, Upgrade, and Connection headers; confirm the client path /lythuyet/socket.io; confirm Node and Nginx use the same port/hostname.

### HTTPS failure

~~~bash
dig lythuyet.mrnauthdev.dpdns.org
sudo ss -ltnp | grep -E ':(80|443)'
sudo nginx -t
sudo certbot certificates
sudo ufw status verbose
~~~

### Permission denied

~~~bash
ls -la /opt/treolythuyet
ls -la /opt/treolythuyet/logs
ls -la /etc/treolythuyet
sudo chown -R "$USER":"$USER" /opt/treolythuyet
sudo chmod 640 /etc/treolythuyet/firebase-service-account.json
~~~

Never use chmod 777.

## Security

Never commit .env, Firebase credentials, passwords, API keys, private keys, access tokens, or session secrets. Keep credentials outside Git with restrictive ownership. Use a least-privilege Linux account, expose only 22/80/443, keep Node on localhost, use HTTPS, preserve SSH access before UFW, update the OS, and upgrade dependencies deliberately.

## Project Structure

| Path | Purpose |
| --- | --- |
| server.js | Express server, APIs, Socket.IO, runtime state, logs. |
| index.js | CLI entry point. |
| bot.js | Playwright session engine. |
| autoCourseEngine.js | Auto-Scan engine. |
| autoCourseRegistry.js | Auto-Scan ownership/timers. |
| courseScanner.js | Course/date/time helpers. |
| firebase-service.js | Firebase Admin/Firestore. |
| stateSync.js | Serialized state synchronization. |
| ecosystem.config.js | PM2 configuration. |
| client/ | React/Vite source and lockfile. |
| src/ | Frontend source mirror. |
| scripts/verifyFirebaseAdmin.js | Firebase verification. |
| test/ | Node.js tests. |
| public/ | Generated client output. |
| .env.example | Environment examples. |

## Complete End-to-End Deployment

1. Install required packages and Node 20 using the commands above.
2. Clone https://github.com/NAUTH05/treolythuyet_latest.git into /opt/treolythuyet.
3. Run git checkout test_dev, git branch --show-current, and git log -1 --oneline.
4. Run npm ci, then run cd client && npm ci && cd ..
5. Run npx playwright install-deps chromium and npm run install-browser.
6. Put Firebase JSON under /etc/treolythuyet/, create .env, and set ADMIN_PASSWORD, PORT, and one Firebase credential method.
7. Set secure ownership/modes and run npm run verify:firebase-admin.
8. Run npm run build and npm test.
9. Run npm start; test curl -I http://127.0.0.1:3000/lythuyet/; stop with Ctrl+C.
10. Install PM2, run pm2 start ecosystem.config.js, and verify pm2 status.
11. Run pm2 save and pm2 startup, execute PM2's printed command, reboot, and verify.
12. Point lythuyet.mrnauthdev.dpdns.org to the VPS IP and verify DNS.
13. Configure Nginx with the exact hostname, run sudo nginx -t, and reload.
14. Allow OpenSSH and Nginx Full in UFW.
15. Run sudo certbot --nginx -d lythuyet.mrnauthdev.dpdns.org and sudo certbot renew --dry-run.
16. Test HTTP/HTTPS, open https://lythuyet.mrnauthdev.dpdns.org, and verify Socket.IO.
17. Reboot and verify PM2, Nginx, and the HTTPS URL again.

## Deployment Checklist

- [ ] VPS prepared
- [ ] Git installed
- [ ] Compatible Node.js installed
- [ ] test_dev checked out and verified
- [ ] Dependencies installed
- [ ] Playwright installed
- [ ] Firebase and .env configured
- [ ] Secure permissions configured
- [ ] Firebase verification passed
- [ ] Build and tests passed
- [ ] Manual run passed
- [ ] PM2 and startup configured
- [ ] DNS resolves to VPS
- [ ] Nginx configured and tested
- [ ] Firewall configured
- [ ] HTTPS certificate issued
- [ ] HTTP to HTTPS verified
- [ ] Public URL verified
- [ ] Socket.IO/WebSocket verified
- [ ] Application survives reboot

Final public URL: https://lythuyet.mrnauthdev.dpdns.org
