const Redis = require('ioredis');
const config = require('../config');

const redisClient = new Redis({
  host: config.redis.redis_host,
  port: config.redis.redis_port,
  password: config.redis.redis_password,
  // Default ioredis retry strategy is sufficient for now.
  // It will attempt to reconnect indefinitely with an exponential backoff.
});

redisClient.on('connect', () => {
  console.log(`Successfully connected to Redis at ${config.redis.redis_host}:${config.redis.redis_port}`);
});

redisClient.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redisClient.on('reconnecting', () => {
  console.log(`Redis client is attempting to reconnect to ${config.redis.redis_host}:${config.redis.redis_port}...`);
});

module.exports = redisClient;
