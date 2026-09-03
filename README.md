# Treo Hoc Ly Thuyet - Windows Server

This branch is the Windows Server deployment edition. The fixed application uses Firestore as the persistent source of truth for accounts, presets, queues, and Auto-Scan state. No `accounts.json` or local JSON database is required.

## Requirements

- Windows Server 2019 or later
- Node.js LTS (64-bit), Git for Windows, npm
- PowerShell 5.1 or PowerShell 7
- Firebase service-account credentials with Firestore access
- Playwright Chromium
- IIS, URL Rewrite, and ARR for a public HTTPS domain

## Install

Run PowerShell as the deployment account:

```powershell
New-Item -ItemType Directory -Force C:\Apps\treolythuyet_latest | Out-Null
Set-Location C:\Apps
git clone -b dev-windows https://github.com/NAUTH05/treolythuyet_latest treolythuyet_latest
Set-Location C:\Apps\treolythuyet_latest

npm ci
Push-Location client
npm ci
npm run build
Pop-Location
npm run install-browser
Test-Path .\public\index.html
```

The final command must return `True`. The client has a separate `package.json`, so both dependency trees must be installed.

## Firebase and .env

Keep the Firebase key outside the repository:

```powershell
New-Item -ItemType Directory -Force C:\Secure\TreoWeb | Out-Null
Copy-Item C:\Path\To\firebase-service-account.json C:\Secure\TreoWeb\firebase-service-account.json
Copy-Item .env.example .env
notepad .env
```

Example:

```env
NODE_ENV=production
PORT=3000
ADMIN_PASSWORD=replace-with-a-long-random-password
FIREBASE_SERVICE_ACCOUNT_FILE=C:\Secure\TreoWeb\firebase-service-account.json
```

Never commit `.env`, a private key, or a service-account JSON file. Restrict the key with NTFS permissions.

Verify before starting PM2:

```powershell
$env:FIREBASE_SERVICE_ACCOUNT_FILE = 'C:\Secure\TreoWeb\firebase-service-account.json'
npm run verify:firebase-admin
```

If this reports `UNAUTHENTICATED`, check the key and Windows time synchronization. Firestore rules do not control OAuth authentication.

## Local start

```powershell
npm start
Invoke-WebRequest http://127.0.0.1:3000/lythuyet/ -UseBasicParsing
```

Expected status is `200`. Use the server IP from another computer; `localhost` refers to the computer running the browser.

## PM2 and reboot

Set variables in the same PowerShell session before starting PM2:

```powershell
$env:FIREBASE_SERVICE_ACCOUNT_FILE = 'C:\Secure\TreoWeb\firebase-service-account.json'
$env:ADMIN_PASSWORD = 'replace-with-a-long-random-password'
$env:PORT = '3000'

npm install -g pm2
pm2 start ecosystem.config.js --update-env
pm2 status
pm2 logs treoweb
pm2 save
```

For reboot persistence, create a Windows Task Scheduler task running at startup under the same service account:

```text
Program: C:\Program Files\nodejs\pm2.cmd
Arguments: resurrect
Start in: C:\Apps\treolythuyet_latest
```

Do not use Linux-only `pm2 startup` or `systemctl` commands on Windows.

## IIS/ARR reverse proxy

Node listens on HTTP port `3000`. IIS must terminate TLS on port `443` and ARR must proxy to `http://127.0.0.1:3000`.

### Use the hostname root without `/lythuyet`

To open the Dashboard at `https://lythuyet.nauthdev.qd.je/`, keep the existing Node routes and rewrite only the IIS root request internally. The browser remains on the clean hostname while the application continues using `/lythuyet`, `/lythuyet/api`, and `/lythuyet/socket.io` internally.

Use this `web.config` in `C:\inetpub\treoweb-proxy`:

```xml
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="TreoWeb dashboard root" stopProcessing="true">
          <match url="^$" />
          <action type="Rewrite" url="http://127.0.0.1:3000/lythuyet/" appendQueryString="true" />
        </rule>
        <rule name="TreoWeb reverse proxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:3000/{R:0}" appendQueryString="true" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

The first rule handles `/`. The second rule preserves the existing asset, API, and Socket.IO paths.

Install the IIS Web Server role, WebSocket Protocol, IIS URL Rewrite, and Application Request Routing:

- https://www.iis.net/downloads/microsoft/url-rewrite
- https://www.iis.net/downloads/microsoft/application-request-routing

Enable ARR proxying in IIS Manager:

```text
Server -> Application Request Routing Cache -> Server Proxy Settings -> Enable proxy
```

The IIS site root should contain only proxy configuration:

```text
C:\Apps\treolythuyet_latest  Node source
C:\inetpub\treoweb-proxy     IIS site root
C:\Secure\TreoWeb             Firebase and TLS private files
```

Create the root and configuration:

```powershell
New-Item -ItemType Directory -Force C:\inetpub\treoweb-proxy | Out-Null
notepad C:\inetpub\treoweb-proxy\web.config
```

Use this file. The first character must be `<`; do not indent an XML declaration before the root element:

```xml
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="TreoWeb reverse proxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:3000/{R:0}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

### HTTPS binding

In IIS Manager:

1. Right-click **Sites** -> **Add Website**.
2. Site name: `TreoWeb`.
3. Physical path: `C:\inetpub\treoweb-proxy`.
4. Type: `https`.
5. IP address: `All Unassigned`.
6. Port: `443`.
7. Host name: `lythuyet.nauthdev.qd.je`.
8. Select the certificate for that hostname.
9. Enable **Require Server Name Indication (SNI)** when other HTTPS sites share the IP.

Expected binding:

```text
https *:443:lythuyet.nauthdev.qd.je sslFlags=1
```

PID 4 (`System`) owning port 443 is normal for IIS/HTTP.sys.

### Certificate choices

For a Cloudflare-proxied record, create a Cloudflare Origin Certificate for `lythuyet.nauthdev.qd.je`, install it in `Cert:\LocalMachine\My`, bind it to IIS, and set Cloudflare SSL/TLS to **Full (strict)**.

For a browser-trusted certificate, use win-acme or Certify The Web to request a Let's Encrypt certificate and install the IIS binding automatically. If converting Cloudflare PEM files to PFX, use a complete OpenSSL installation and a password-protected PFX. An OpenSSL package without `legacy.dll` cannot run the `-legacy` conversion; use a standard PFX or win-acme instead.

### Create and install a certificate with win-acme

win-acme (WACS) is the recommended Windows/IIS path when you want a browser-trusted Let's Encrypt certificate without manually creating a PFX:

1. Download the current win-acme release from `https://www.win-acme.com/` and extract it, for example, to `C:\Tools\win-acme`.
2. Open PowerShell as Administrator and run `C:\Tools\win-acme\wacs.exe`.
3. Choose **Create certificate (N)**.
4. Choose the IIS source, select site `TreoWeb`, and select the hostname `lythuyet.nauthdev.qd.je`.
5. Choose the default Windows Certificate Store and IIS installation/binding steps when prompted.
6. Choose a validation method. HTTP-01 requires public TCP `80` and an HTTP binding for `lythuyet.nauthdev.qd.je`; with Cloudflare proxying, temporarily switch the DNS record to **DNS only** during validation. DNS-01 can be used instead when port `80` cannot be exposed.
7. Confirm the requested certificate and allow win-acme to create its renewal scheduled task.

After successful issuance, keep Cloudflare DNS **Proxied** and set SSL/TLS to **Full (strict)**. win-acme renewals update the IIS certificate/binding automatically; do not copy the certificate or private key into the application directory.

Verify the certificate and binding:

```powershell
Get-ChildItem Cert:\LocalMachine\My |
  Where-Object Subject -Match 'lythuyet\.nauthdev\.qd\.je' |
  Select-Object Subject, Thumbprint, NotAfter

Get-WebBinding -Name TreoWeb -Protocol https |
  Select-Object bindingInformation, certificateHash, certificateStoreName, sslFlags
```

The expected binding is `https *:443:lythuyet.nauthdev.qd.je sslFlags=1`. Test renewal status in **Task Scheduler** under **Task Scheduler Library -> win-acme**.

Keep the DNS record pointed to the server and proxied:

```text
lythuyet.nauthdev.qd.je  A  160.250.180.238  Proxied
```

Do not proxy Cloudflare directly to port `3000`. Allow inbound TCP `443` in Windows Firewall.

## Troubleshooting

Test Node first:

```powershell
Invoke-WebRequest http://127.0.0.1:3000/lythuyet/ -UseBasicParsing
```

Test the public domain:

```powershell
try {
  Invoke-WebRequest https://lythuyet.nauthdev.qd.je/ -UseBasicParsing
} catch {
  Write-Host 'HTTP status:' $_.Exception.Response.StatusCode.value__
  $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
  $reader.ReadToEnd()
}
```

PowerShell 5.1 may not include `curl.exe`; use `Invoke-WebRequest`.

Common errors:

- `525`: Cloudflare cannot complete TLS with the origin. Check the IIS certificate and binding.
- `500.19`: IIS cannot parse `web.config`, or URL Rewrite is missing. Ensure the file starts directly with `<configuration>`.
- `500.50` or `500.52`: URL Rewrite/ARR configuration problem.
- `502.3`: IIS cannot connect to Node on port `3000`.

Diagnostics:

```powershell
Get-WebGlobalModule | Select-Object Name, ImagePath
Get-WindowsFeature Web-WebSockets
Get-Website
Get-WebBinding
Get-Content C:\inetpub\treoweb-proxy\web.config

& "$env:WINDIR\System32\inetsrv\appcmd.exe" list config "TreoWeb/" /section:system.webServer/rewrite/rules

$log = Get-ChildItem C:\inetpub\logs\LogFiles -Recurse -Filter *.log |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $log.FullName -Tail 30
```

After changes:

```powershell
iisreset
pm2 restart treoweb --update-env
```

## Existing Linux/VPS VHost configuration

The fixed application still supports the existing Linux deployment:

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

## Validation checklist

```powershell
npm test
Push-Location client
npm run build
Pop-Location
npm run verify:firebase-admin
```

Confirm `accounts.json` is absent, `public\index.html` exists, Node returns `200`, Firebase verification passes, IIS serves the HTTPS URL, Socket.IO upgrades work, and PM2 survives restart/reboot.
