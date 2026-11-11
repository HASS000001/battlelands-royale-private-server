const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    code: 429,
    status: 'TooManyRequests',
    error: 'RateLimitExceeded',
    errorMessage: 'Too many login attempts.',
    errorDetails: {}
  }
});

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.playFabId || req.ip,
  message: {
    code: 429,
    status: 'TooManyRequests',
    error: 'RateLimitExceeded',
    errorMessage: 'Too many requests.',
    errorDetails: {}
  }
});

module.exports = { loginLimiter, apiLimiter };
