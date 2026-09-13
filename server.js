require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieSession = require('cookie-session');
const apiRoutes = require('./routes/api');
const redirectRoutes = require('./routes/redirects');
const authRoutes = require('./routes/auth');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'fallback_dev_secret_please_change';

// Production Environment Validation
if (process.env.NODE_ENV === 'production') {
    if (!process.env.SESSION_SECRET) {
        console.error('Missing required environment variable: SESSION_SECRET');
        process.exit(1);
    }
    if (!process.env.ADMIN_PASSWORD_HASH) {
        console.error('Missing required environment variable: ADMIN_PASSWORD_HASH');
        process.exit(1);
    }
    // Trust proxy on Vercel to ensure 'secure: true' cookies work properly
    app.set('trust proxy', 1);
}

// Security Headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
        }
    }
}));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});

const redirectLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 60,
    message: 'Too many redirects requested from this IP.'
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Limit login attempts to 10 per 15 mins
    message: { error: 'Too many login attempts. Please try again later.' }
});

// JSON parser with size limit
app.use(express.json({ limit: '10kb' }));

// Global error handler for JSON parsing issues
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'Malformed JSON payload' });
    }
    next();
});

// Subdomain Alias Detection Middleware
app.use((req, res, next) => {
    const baseDomain = process.env.REDIRECT_BASE_DOMAIN;
    let host = req.hostname;
    if (!host) return next();

    host = host.toLowerCase();
    
    let alias = null;
    if (baseDomain && host.endsWith('.' + baseDomain.toLowerCase())) {
        alias = host.slice(0, -('.' + baseDomain).length);
    } else if (process.env.NODE_ENV !== 'production' && host.endsWith('.localhost')) {
        alias = host.slice(0, -('.localhost').length);
    }
    
    if (alias && alias !== 'www') {
        if (req.path === '/') {
            const { handleRedirect } = require('./routes/redirectHandler');
            return handleRedirect(alias, res);
        }
    }
    next();
});

// Stateless cookie session configuration (Vercel compatible)
app.use(cookieSession({
    name: 'session',
    secret: SESSION_SECRET,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', // true if using HTTPS in prod
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

// Static files (only /public is served)
app.use(express.static(path.join(__dirname, 'public')));

// Authentication Routes
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);

// Auth Middleware for /api (protects POST, PATCH, DELETE, GET /redirects)
function requireAuth(req, res, next) {
    if (req.path === '/health') {
        return next();
    }
    if (req.session && req.session.authenticated) {
        return next();
    }
    return res.status(401).json({ error: 'Authentication required' });
}

// Routes
app.use('/api', apiLimiter, requireAuth, apiRoutes);
app.use('/r', redirectLimiter, redirectRoutes);

// Fallback Global Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack); // Log locally
    res.status(500).json({ error: 'Internal Server Error' });
});

// Local development server vs Vercel Serverless Export
if (require.main === module) {
    const server = app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });

    // Graceful Shutdown
    function shutdown(signal) {
        console.log(`\nReceived ${signal}. Shutting down gracefully...`);
        server.close(() => {
            console.log('Closed out remaining connections.');
            if (db && typeof db.closeGracefully === 'function') {
                db.closeGracefully(() => {
                    process.exit(0);
                });
            } else {
                process.exit(0);
            }
        });

        setTimeout(() => {
            console.error('Could not close connections in time, forcefully shutting down');
            process.exit(1);
        }, 10000);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
