const Redis = require('ioredis');

function createNoopRedis() {
  return {
    get: async function() { return null; },
    set: async function() { return 'OK'; },
    del: async function() { return 0; },
    quit: async function() { return undefined; },
    on: function() { return undefined; },
  };
}

var redis;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  redis.on('error', function(err) {
    console.error('Erro no Redis:', err.message);
  });
} else {
  redis = createNoopRedis();
}

module.exports = redis;
