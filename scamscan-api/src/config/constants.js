module.exports = {
    PORT: process.env.PORT || 3000,
    RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000, // 15 minutes
    RATE_LIMIT_MAX: 100 // 100 requests per 15 min (was probably too strict before)
};