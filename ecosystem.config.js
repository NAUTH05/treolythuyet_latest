module.exports = {
  apps: [
    {
      name: 'treoweb',
      script: 'server.js',
      // Web dashboard mode (default)
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      merge_logs: true,
      // PM2 only configures process behavior. Secrets and Firebase credentials
      // live in .env / external credential files and are loaded by config/env.js
      // on every process start. Never copy them here: PM2 loading this file
      // without .env would inject empty strings that shadow the real values.
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
