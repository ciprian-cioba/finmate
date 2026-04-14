import crypto from 'crypto';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

/* ------------------ Config ------------------ */

const CONFIG = {
    MAX_IMAGES: Number(process.env.MAX_IMAGES || 3),
    MAX_REQUESTS_PER_WINDOW: Number(process.env.RATE_LIMIT || 5),
    WINDOW_MS: Number(process.env.RATE_WINDOW_MS || 60000),
    MAX_IMAGE_SIZE_KB: Number(process.env.MAX_IMAGE_SIZE_KB || 2048),
    GEMINI_TIMEOUT_MS: Number(process.env.GEMINI_TIMEOUT_MS || 120000),
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean),
    REQUIRE_TOKEN: Boolean(process.env.APP_TOKEN)
};

if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠️ GEMINI_API_KEY missing');
}

/* ------------------ Utils ------------------ */

function getIP(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.headers['cf-connecting-ip'] ||
        'unknown'
    );
}

function hashIP(ip) {
    return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 12);
}

function getRateKey(req, ip) {
    const token = req.headers['x-app-token'] || 'anon';
    return `rate:${token}:${ip}`;
}

async function isRateLimited(key) {
    const now = Date.now();
    const windowStart = now - CONFIG.WINDOW_MS;

    // sliding window using sorted set
    await redis.zremrangebyscore(key, 0, windowStart);
    const count = await redis.zcard(key);

    if (count >= CONFIG.MAX_REQUESTS_PER_WINDOW) {
        const ttl = await redis.pttl(key);
        return { limited: true, remaining: 0, reset: Math.ceil(ttl / 1000) };
    }

    await redis.zadd(key, now, `${now}-${Math.random()}`);
    await redis.pexpire(key, CONFIG.WINDOW_MS);

    return {
        limited: false,
        remaining: CONFIG.MAX_REQUESTS_PER_WINDOW - (count + 1),
        reset: Math.ceil(CONFIG.WINDOW_MS / 1000)
    };
}

function setRateHeaders(res, rate) {
    res.setHeader('X-RateLimit-Limit', CONFIG.MAX_REQUESTS_PER_WINDOW);
    res.setHeader('X-RateLimit-Remaining', rate.remaining);
    res.setHeader('X-RateLimit-Reset', rate.reset);
}

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

function hashImage(base64) {
    return crypto.createHash('sha256').update(base64).digest('hex');
}

/* ------------------ Validation ------------------ */

function validateImages(images) {
    if (!Array.isArray(images)) return 'Images must be an array';
    if (images.length === 0) return 'At least one image required';
    if (images.length > CONFIG.MAX_IMAGES) return `Max ${CONFIG.MAX_IMAGES} images`;

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];

    for (let i = 0; i < images.length; i++) {
        const img = images[i];

        if (typeof img !== 'string') {
            return `Image ${i + 1}: must be string`;
        }

        const match = img.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) {
            return `Image ${i + 1}: invalid data URI`;
        }

        const mime = match[1];
        const base64 = match[2];

        if (!allowed.includes(mime)) {
            return `Image ${i + 1}: unsupported format`;
        }

        // decode first → correct size validation
        const buffer = Buffer.from(base64, 'base64');
        const sizeKB = buffer.length / 1024;

        if (sizeKB > CONFIG.MAX_IMAGE_SIZE_KB) {
            return `Image ${i + 1}: too large (${sizeKB.toFixed(1)}KB)`;
        }
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
        generationConfig: {
            responseMimeType: 'application/json'
        },
        contents: [{
            parts: [
                {
                    text: `Extract receipt data as JSON:
{
  "store": string|null,
  "date": string|null,
  "items": [{ "name": string, "quantity": number, "price": number, "unitPrice": ["number","null"], "subtotal": ["number","null"], "tax": ["number","null"] }],
  "total": number
}`
                },
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
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': apiKey
                    },
                    signal: AbortSignal.timeout(CONFIG.GEMINI_TIMEOUT_MS),
                    body: JSON.stringify(body)
                }
            );

            if (res.status >= 500 || res.status === 429) {
                throw new Error(`retryable-${res.status}`);
            }

            if (!res.ok) {
                throw new Error(`Gemini ${res.status}`);
            }

            const data = await res.json();
            let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (!text) throw new Error('Invalid Gemini response');

            // strip markdown ```json
            text = text.replace(/```json|```/g, '').trim();

            try {
                return {
                    success: true,
                    receipt: JSON.parse(text)
                };
            } catch (err) {
                const error = new Error('invalid JSON');
                error.raw = text;
                throw error;
            }

        } catch (err) {
            if (err.name === 'TimeoutError') {
                throw new Error('timeout');
            }

            if (err.message.startsWith('retryable')) {
                await new Promise(r => setTimeout(r, 2 ** attempt * 500));
                attempt++;
                continue;
            }

            throw err;
        }
    }

    throw new Error('Gemini failed after retries');
}

/* ------------------ Handler ------------------ */

export default async function handler(req, res) {
    setCORS(req, res);

    if (req.method === 'OPTIONS') {
        return res.status(204).end(); // optimized preflight
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'POST only' });
    }

    const ip = getIP(req);
    const maskedIP = hashIP(ip);
    const key = getRateKey(req, ip);
    const requestId = Math.random().toString(36).slice(2, 8);

    try {
        if (!isAuthorized(req)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const rate = await isRateLimited(key);
        setRateHeaders(res, rate);

        if (rate.limited) {
            return res.status(429).json({
                error: 'Rate limit exceeded',
                retryAfter: rate.reset
            });
        }

        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Invalid JSON body' });
        }

        const { images } = req.body;

        const validationError = validateImages(images);
        if (validationError) {
            return res.status(400).json({ error: validationError });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Server misconfigured' });
        }

        console.log(`[${requestId}] ${maskedIP} -> ${images.length} images`);

        // 1. Create a single hash for the entire batch of images
        const requestHash = hashImage(images.join(''));
        const cacheKey = `ocr:${requestHash}`;

        // 2. Check if this exact batch of images has been processed recently
        const cachedData = await redis.get(cacheKey);
        if (cachedData) {
            console.log(`[${requestId}] Cache hit for ${maskedIP}`);
            const parsedCache = JSON.parse(cachedData);
            
            // Return the stored result, and inject 'cached: true' so the client knows
            return res.status(200).json({ 
                ...parsedCache, 
                cached: true 
            });
        }

        // 3. Not in cache -> Call Gemini
        const result = await callGemini(images, apiKey);

        // 4. Save the actual result object to Redis as a string for 5 minutes (300s)
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);

        return res.status(200).json(result);

    } catch (err) {
        console.error(`[${requestId}]`, err.message);

        let status = 500;
        let error = 'OCR failed';

        if (err.message === 'timeout') {
            status = 504;
            error = 'Timeout';
        }

        if (err.message === 'invalid JSON') {
            status = 502;
            error = 'Invalid JSON from AI';
        }

        return res.status(status).json({
            error,
            requestId,
            ...(process.env.NODE_ENV !== 'production' && {
                details: err.message,
                raw: err.raw
            })
        });
    }
}