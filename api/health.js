import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export default async function handler(req, res) {
    // Standard CORS headers
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-token');

    if (req.method === 'OPTIONS') return res.status(204).end();

    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            redis: 'checking...',
            gemini_config: !!process.env.GEMINI_API_KEY ? 'present' : 'missing'
        }
    };

    try {
        // Ping Redis
        const redisStatus = await redis.ping();
        health.services.redis = redisStatus === 'PONG' ? 'connected' : 'error';
    } catch (err) {
        health.status = 'error';
        health.services.redis = `disconnected: ${err.message}`;
    }

    const statusCode = health.status === 'ok' ? 200 : 503;
    return res.status(statusCode).json(health);
}