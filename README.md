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