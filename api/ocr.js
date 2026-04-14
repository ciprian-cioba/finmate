const CONFIG = {
    MAX_IMAGES: parseInt(process.env.MAX_IMAGES || '3'),
    MAX_REQUESTS_PER_WINDOW: parseInt(process.env.RATE_LIMIT || '5'),
    WINDOW_MS: parseInt(process.env.RATE_WINDOW_MS || '60000'),
    MAX_IMAGE_SIZE_KB: parseInt(process.env.MAX_IMAGE_SIZE_KB || '1024'),
    GEMINI_TIMEOUT_MS: parseInt(process.env.GEMINI_TIMEOUT_MS || '25000'),
    ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim())
};

// Validate config at startup
if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠️ GEMINI_API_KEY not set - OCR will fail');
}

const rateStore = new Map();

// Cleanup old rate limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateStore.entries()) {
        if (now - entry.start > CONFIG.WINDOW_MS) {
            rateStore.delete(ip);
        }
    }
}, 5 * 60 * 1000);

function getIP(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip']?.trim() ||
        req.headers['cf-connecting-ip']?.trim() || // Cloudflare
        'unknown'
    );
}

function rateLimit(ip) {
    const now = Date.now();
    const entry = rateStore.get(ip);

    if (!entry) {
        rateStore.set(ip, { count: 1, start: now });
        return false;
    }

    if (now - entry.start > CONFIG.WINDOW_MS) {
        rateStore.set(ip, { count: 1, start: now });
        return false;
    }

    if (entry.count >= CONFIG.MAX_REQUESTS_PER_WINDOW) {
        return true;
    }

    entry.count++;
    return false;
}

function setCORSHeaders(res, origin) {
    const allowedOrigins = CONFIG.ALLOWED_ORIGINS;
    const isAllowed = allowedOrigins.includes('*') || allowedOrigins.includes(origin);

    if (isAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
}

function validateImages(images) {
    if (!Array.isArray(images)) {
        return 'Images must be an array';
    }

    if (images.length === 0) {
        return 'At least one image is required';
    }

    if (images.length > CONFIG.MAX_IMAGES) {
        return `Maximum ${CONFIG.MAX_IMAGES} images allowed`;
    }

    for (let i = 0; i < images.length; i++) {
        const img = images[i];

        // Type check
        if (typeof img !== 'string') {
            return `Image ${i + 1}: must be a string (data URI)`;
        }

        // Format check
        if (!img.startsWith('data:image/')) {
            return `Image ${i + 1}: invalid format. Expected data URI (data:image/...)`;
        }

        // Size check - proper base64 overhead calculation
        // Base64 encoded size is roughly 4/3 of binary size
        const sizeKB = Buffer.byteLength(img) / 1024;
        if (sizeKB > CONFIG.MAX_IMAGE_SIZE_KB) {
            return `Image ${i + 1}: exceeds size limit (${sizeKB.toFixed(1)}KB > ${CONFIG.MAX_IMAGE_SIZE_KB}KB)`;
        }
    }

    return null;
}

async function callGeminiAPI(images, apiKey) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.GEMINI_TIMEOUT_MS);

    try {
        const imageParts = images.map(img => {
            // Extract base64 data and MIME type from data URI
            const matches = img.match(/^data:(image\/[^;]+);base64,(.+)$/);
            if (!matches) {
                throw new Error('Invalid image data URI format');
            }

            const [, mimeType, data] = matches;

            return {
                inlineData: {
                    mimeType,
                    data
                }
            };
        });

        const response = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                },
                body: JSON.stringify({
                    generationConfig: {
                        responseMimeType: 'application/json',
                        responseSchema: {
                            type: 'object',
                            properties: {
                                store: { type: 'string', description: 'Store or vendor name' },
                                date: { type: 'string', description: 'Date of purchase (YYYY-MM-DD or raw if unclear)' },
                                items: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            name: { type: 'string' },
                                            quantity: { type: 'number' },
                                            unitPrice: { type: 'number' },
                                            price: { type: 'number' }
                                        },
                                        required: ['name', 'quantity', 'price']
                                    }
                                },
                                subtotal: { type: 'number' },
                                tax: { type: 'number' },
                                total: { type: 'number' }
                            },
                            required: ['items', 'total']
                        }
                    },
                    contents: [{
                        parts: [
                            {
                                text: 'Extract all receipt data from these images. Return structured JSON with store name, items (name, quantity, unit price, total price), subtotal, tax, and final total. Use null for unknown fields.'
                            },
                            ...imageParts
                        ]
                    }]
                })
            }
        );

        clearTimeout(timeout);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini API error ${response.status}: ${errorText.slice(0, 200)}`);
        }

        const data = await response.json();

        // Check for API errors in response
        if (data.error) {
            throw new Error(`Gemini error: ${data.error.message}`);
        }

        // Extract text content from response
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
            throw new Error('Invalid Gemini response format');
        }

        return {
            success: true,
            receipt: JSON.parse(data.candidates[0].content.parts[0].text)
        };

    } catch (err) {
        clearTimeout(timeout);

        if (err.name === 'AbortError') {
            throw new Error(`Gemini API timeout (${CONFIG.GEMINI_TIMEOUT_MS}ms)`);
        }

        throw err;
    }
}

export default async function handler(req, res) {
    const origin = req.headers.origin || '';
    setCORSHeaders(res, origin);

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    const ip = getIP(req);
    const requestId = Math.random().toString(36).slice(2, 9);

    try {
        // Rate limiting
        if (rateLimit(ip)) {
            console.warn(`[${requestId}] Rate limit exceeded for IP: ${ip}`);
            return res.status(429).json({
                error: 'Rate limit exceeded',
                retryAfter: Math.ceil(CONFIG.WINDOW_MS / 1000)
            });
        }

        // Validate body
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({
                error: 'Request body must be JSON',
                example: { images: ['data:image/jpeg;base64,...'] }
            });
        }

        const { images } = req.body;

        // Validate images
        const validationError = validateImages(images);
        if (validationError) {
            console.warn(`[${requestId}] Validation error: ${validationError}`);
            return res.status(400).json({ error: validationError });
        }

        // Check API key
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error(`[${requestId}] GEMINI_API_KEY not configured`);
            return res.status(500).json({
                error: 'Server misconfigured',
                details: 'GEMINI_API_KEY environment variable is not set'
            });
        }

        // Call Gemini
        console.log(`[${requestId}] Processing ${images.length} image(s)`);
        const result = await callGeminiAPI(images, apiKey);

        console.log(`[${requestId}] Success`);
        return res.status(200).json(result);

    } catch (err) {
        console.error(`[${requestId}] Error: ${err.message}`);

        // Determine appropriate status code
        let statusCode = 500;
        let errorMsg = 'OCR processing failed';

        if (err.message.includes('timeout')) {
            statusCode = 504;
            errorMsg = 'Backend service timeout';
        } else if (err.message.includes('API')) {
            statusCode = 503;
            errorMsg = 'External service error';
        }

        return res.status(statusCode).json({
            error: errorMsg,
            requestId, // For debugging
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
};
