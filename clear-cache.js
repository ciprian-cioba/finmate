import Redis from 'ioredis';
import 'dotenv/config';  // If you use a .env file

const redis = new Redis(process.env.REDIS_URL);

async function clearCache() {
    const stream = redis.scanStream({ match: 'ocr:*', count: 100 });
    const pipeline = redis.pipeline();
    let deletedCount = 0;

    stream.on('data', (keys) => {
        if (keys.length) {
            pipeline.del(...keys);
            deletedCount += keys.length;
        }
    });

    stream.on('end', async () => {
        await pipeline.exec();
        console.log(`✅ Cleared ${deletedCount} cache keys`);
        redis.disconnect();
    });
}

clearCache().catch(console.error);