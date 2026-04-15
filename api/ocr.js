import crypto from 'crypto';
import Redis from 'ioredis';

// [Added from v2] Redis error listener to prevent process crashes
const redis = new Redis(process.env.REDIS_URL);
redis.on('error', (err) => console.warn('Redis Connection Warning:', err.message));

/* ------------------ Config ------------------ */

const CONFIG = {
    MAX_IMAGES: Number(process.env.MAX_IMAGES || 3),
    MAX_REQUESTS_PER_WINDOW: Number(process.env.RATE_LIMIT || 5),
    WINDOW_MS: Number(process.env.RATE_WINDOW_MS || 60000),
    MAX_IMAGE_SIZE_KB: Number(process.env.MAX_IMAGE_SIZE_KB || 2048),
    GEMINI_TIMEOUT_MS: Number(process.env.GEMINI_TIMEOUT_MS || 25000),
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean),
    REQUIRE_TOKEN: Boolean(process.env.APP_TOKEN)
};

/* ------------------ Utils ------------------ */

function getIP(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.headers['cf-connecting-ip'] ||
        'unknown'
    );
}

function hashString(str) {
    return crypto.createHash('sha256').update(str).digest('hex');
}

// [Original Feature] Token-aware rate limiting key
function getRateKey(req, ip) {
    const token = req.headers['x-app-token'] || 'anon';
    return `rate:${token}:${hashString(ip).slice(0, 12)}`;
}

// [Merged] Atomic sliding window rate limiting with fail-open safety
async function isRateLimited(key) {
    try {
        const now = Date.now();
        const windowStart = now - CONFIG.WINDOW_MS;

        const multi = redis.multi();
        multi.zremrangebyscore(key, 0, windowStart);
        multi.zcard(key);
        multi.zadd(key, now, `${now}-${Math.random()}`);
        multi.pexpire(key, CONFIG.WINDOW_MS);
        
        const results = await multi.exec();
        const count = results[1][1]; 

        if (count >= CONFIG.MAX_REQUESTS_PER_WINDOW) {
            const ttl = await redis.pttl(key);
            return { limited: true, remaining: 0, reset: Math.ceil(ttl / 1000) };
        }

        return {
            limited: false,
            remaining: CONFIG.MAX_REQUESTS_PER_WINDOW - (count + 1),
            reset: Math.ceil(CONFIG.WINDOW_MS / 1000)
        };
    } catch (e) {
        // [Added from v2] Fail-open: proceed if Redis is down
        console.error("Rate limit check failed, failing open:", e.message);
        return { limited: false, remaining: 1, reset: 60 };
    }
}

// [Original Feature] Modular CORS
function setCORS(req, res) {
    const origin = req.headers.origin;
    if (CONFIG.ALLOWED_ORIGINS.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (CONFIG.ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-token');
}

function isAuthorized(req) {
    if (!CONFIG.REQUIRE_TOKEN) return true;
    return req.headers['x-app-token'] === process.env.APP_TOKEN;
}

/* ------------------ Validation ------------------ */

function validateImages(images) {
    if (!Array.isArray(images)) return 'Images must be an array';
    if (images.length === 0) return 'At least one image required';
    if (images.length > CONFIG.MAX_IMAGES) return `Max ${CONFIG.MAX_IMAGES} images`;

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];

    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (typeof img !== 'string') return `Image ${i + 1}: must be string`;

        const match = img.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) return `Image ${i + 1}: invalid data URI format`;

        if (!allowed.includes(match[1])) return `Image ${i + 1}: unsupported format`;

        const sizeKB = Buffer.from(match[2], 'base64').length / 1024;
        if (sizeKB > CONFIG.MAX_IMAGE_SIZE_KB) return `Image ${i + 1}: too large (${sizeKB.toFixed(1)}KB)`;
    }
    return null;
}

/* ------------------ Gemini ------------------ */

async function callGemini(images, apiKey) {
    const parts = images.map(img => {
        const [, mimeType, data] = img.match(/^data:(image\/[^;]+);base64,(.+)$/);
        return { inlineData: { mimeType, data } };
    });

    const body = {
        generationConfig: { responseMimeType: 'application/json' },
        contents: [{
            parts: [
                { text: `Extract receipt data as JSON: {"store": string|null, "date": string|null, "items": [{"name": string, "qty": 1, "price": 0.0, "weight": '500g or -', "discount": '0% or -'}], "total": number}` },
                ...parts
            ]
        }]
    };

    let attempt = 0;
    while (attempt < 3) {
        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                    signal: AbortSignal.timeout(CONFIG.GEMINI_TIMEOUT_MS),
                    body: JSON.stringify(body)
                }
            );

            if (res.status === 429 || res.status >= 500) throw new Error(`retryable-${res.status}`);
            if (!res.ok) throw new Error(`Gemini Error ${res.status}`);

            const data = await res.json();
            let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Invalid Gemini response');

            text = text.replace(/```json|```/g, '').trim();

            try {
                return { success: true, receipt: JSON.parse(text) };
            } catch (err) {
                const error = new Error('invalid JSON');
                error.raw = text; 
                throw error;
            }
        } catch (err) {
            // [Original Feature] Exponential backoff
            if (err.message.startsWith('retryable') && attempt < 2) {
                await new Promise(r => setTimeout(r, 2 ** attempt * 500));
                attempt++;
                continue;
            }
            throw err;
        }
    }
}

/* ------------------ Handler ------------------ */

export default async function handler(req, res) {
    setCORS(req, res);

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const ip = getIP(req);
    const maskedIP = hashString(ip).slice(0, 12);
    const rateKey = getRateKey(req, ip);
    const requestId = Math.random().toString(36).slice(2, 8);

    try {
        if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

        const rate = await isRateLimited(rateKey);
        res.setHeader('X-RateLimit-Limit', CONFIG.MAX_REQUESTS_PER_WINDOW);
        res.setHeader('X-RateLimit-Remaining', rate.remaining);
        res.setHeader('X-RateLimit-Reset', rate.reset);

        if (rate.limited) return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: rate.reset });

        const { images } = req.body;
        const validationError = validateImages(images);
        if (validationError) return res.status(400).json({ error: validationError });

        const apiKey = process.env.GEMINI_API_KEY;
        const cacheKey = `ocr:${hashString(images.join(''))}`;
        
        // [Merged] Cache check with full payload return
        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                console.log(`[${requestId}] Cache hit for ${maskedIP}`);
                return res.status(200).json({ ...JSON.parse(cached), cached: true });
            }
        } catch (e) { console.warn("Cache lookup failed, proceeding."); }

        console.log(`[${requestId}] Processing for ${maskedIP}`);
        const result = await callGemini(images, apiKey);

        try {
            await redis.set(cacheKey, JSON.stringify(result), 'EX', 600);
        } catch (e) { /* ignore cache write fail */ }

        return res.status(200).json(result);

    } catch (err) {
        console.error(`[${requestId}] Error:`, err.message);

        // [Original Feature] Detailed status codes
        let status = 500;
        let error = 'OCR failed';

        if (err.name === 'TimeoutError' || err.message === 'timeout') {
            status = 504;
            error = 'Gateway Timeout';
        } else if (err.message === 'invalid JSON') {
            status = 502;
            error = 'Bad Gateway (AI response malformed)';
        }

        return res.status(status).json({
            error,
            requestId,
            details: err.message,
            // [Original Feature] Raw output for non-prod debugging
            ...(process.env.NODE_ENV !== 'production' && { raw: err.raw })
        });
    }
}
