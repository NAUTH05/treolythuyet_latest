module.exports = {
  apps: [
    {
      name: 'treoweb',
      script: 'server.js',
      // Web dashboard mode (default)
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        FIREBASE_SERVICE_ACCOUNT_FILE: '/home/dpdns-mrnauthdev/.config/treoweb/firebase-service-account.json',
      },
    },
  ],
};
