# Treo Học Lý Thuyết Lái Xe - Auto Bot

Tự động đăng nhập và treo bài học trên **hoclythuyetlaixe.eco-tek.com.vn**.

## Cài đặt

```bash
# 1. Cài dependencies
npm run setup

# 2. Cấu hình tài khoản
# Sửa file accounts.json với email + mật khẩu của bạn
# 3. sudo install
apt install npm
npx playwright install-deps
```

## Cấu hình tài khoản

Sửa file `accounts.json`:

```json
{
  "accounts": [
    {
      "name": "TenHienThi",
      "email": "email_dang_nhap",
      "password": "mat_khau"
    }
  ]
}
```

Thêm bao nhiêu tài khoản tùy ý.

## Sử dụng

## Firebase Admin SDK

Ứng dụng chỉ truy cập Firestore từ Node.js bằng Firebase Admin SDK. Không nhập hoặc gửi service-account JSON qua Dashboard.

### Cấu hình khuyến nghị trên VPS

1. Firebase Console -> Project settings -> Service accounts -> Generate new private key.
2. Chép file lên VPS, ngoài thư mục Git:

```bash
sudo install -d -m 700 /etc/treohoc
sudo install -m 600 service-account.json /etc/treohoc/firebase-service-account.json
```

3. Cấu hình đường dẫn credential cho tiến trình Node/PM2:

```bash
export FIREBASE_SERVICE_ACCOUNT_FILE=/etc/treohoc/firebase-service-account.json
npm run verify:firebase-admin
```

Với PM2, thêm biến sau vào phần `env` của cấu hình triển khai rồi restart tiến trình:

```js
FIREBASE_SERVICE_ACCOUNT_FILE: '/etc/treohoc/firebase-service-account.json'
```

Các nguồn credential khác được hỗ trợ:

- `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/service-account.json`
- `FIREBASE_SERVICE_ACCOUNT_JSON` chứa JSON đầy đủ
- `FIREBASE_SERVICE_ACCOUNT_BASE64` chứa JSON mã hóa base64
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- File local `firebase-service-account.json` trong thư mục ứng dụng (đã được `.gitignore`, nhưng file ngoài repository vẫn an toàn hơn)

Không commit service-account JSON, private key hoặc `.env` vào Git.

### Chuyển Firestore Rules sang deny-all

Chỉ publish rules dưới đây sau khi `npm run verify:firebase-admin` báo thành công và log server có:

```text
[FIREBASE] Admin SDK initialized
[FIREBASE] Firestore connection verified
[FIREBASE] Using server-side Admin SDK authentication
```

```firestore
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Firebase Admin SDK chạy trên server không phụ thuộc Firestore client Security Rules. Dashboard chỉ gọi API Node.js và không chứa Firebase browser SDK.

### Web Dashboard (Mặc định)

```bash
npm start
# Hoặc với PM2:
pm2 start ecosystem.config.js
```

Truy cập Dashboard tại: `https://mrnauthdev.dpdns.org/lythuyet`

### CLI Mode

```bash
# Treo 1 bài 4 tiếng
node index.js --url https://hoclythuyetlaixe.eco-tek.com.vn/slides/slide/ten-bai-hoc
```

## Chạy trên VPS với PM2

```bash
# Cài PM2 global
npm install -g pm2

# Khởi chạy Web Dashboard
pm2 start ecosystem.config.js

# Xem log
pm2 logs treoweb

# Lưu trạng thái PM2 khởi động cùng hệ thống
pm2 save
pm2 startup
```

## Tính năng stealth (chống phát hiện bot)

- Fake User-Agent (Chrome thật)
- Fake timezone Việt Nam
- Fake ngôn ngữ vi-VN
- Xóa `navigator.webdriver`
- Override Visibility API (trang luôn nghĩ tab đang active)
- Giả lập mouse movement ngẫu nhiên
- Giả lập scroll
- Giả lập click

## Cấu trúc project

```
treohoclythuyet/
├── server.js              # Web Dashboard Express + Socket.IO server
├── bot.js                 # Automation core (Playwright)
├── index.js               # CLI mode
├── client/                # React Dashboard Frontend
├── public/                # Build output tĩnh (Vite build)
├── ecosystem.config.js     # PM2 Config
├── package.json
└── README.md
```
## Fast Setup
``` # 1. Clone dự án từ GitHub
git clone https://github.com/NAUTH05/treolythuyet.git
cd treolythuyet
# 2. Cài đặt dependencies, build client & cài chromium cho Playwright
npm run setup
# 3. Tạo file cấu hình tài khoản từ file mẫu
cp accounts.example.json accounts.json
# Sửa file accounts.json để thêm email/mật khẩu của bạn
nano accounts.json
# 4. Khởi chạy dự án bằng PM2
pm2 start ecosystem.config.js
# 5. Lưu trạng thái PM2 khởi động cùng hệ thống
pm2 save
pm2 startup
```
## Proxy
```
# Cấu hình Reverse Proxy cho dự án Treo Học Lý Thuyết
location /lythuyet {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    # Hỗ trợ WebSocket cho Socket.IO
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Headers thực tế từ client
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Giữ kết nối Socket.IO dài hạn không bị ngắt
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
```

## Cockpit
IP:9090
apt update && apt install -y cockpit
systemctl enable --now cockpit.socket
ufw allow 9090/tcp && ufw reload
### permision FIX
```
echo "root" >> /etc/cockpit/disallowed-users
sed -i '/root/d' /etc/cockpit/disallowed-users
```
systemctl restart cockpit
