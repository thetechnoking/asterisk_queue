require('dotenv').config();

module.exports = {
  asterisk: {
    ari_host: process.env.ARI_HOST || '127.0.0.1',
    ari_port: process.env.ARI_PORT || 8088,
    ari_username: process.env.ARI_USERNAME,
    ari_password: process.env.ARI_PASSWORD,
    ari_appName: process.env.ARI_APP_NAME || 'dialer',
  },
  redis: {
    redis_host: process.env.REDIS_HOST || '127.0.0.1',
    redis_port: process.env.REDIS_PORT || 6379,
    redis_password: process.env.REDIS_PASSWORD || null,
  },
  application: {
    log_level: process.env.LOG_LEVEL || 'info',
  },
};
