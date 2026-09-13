const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

// POST /api/auth/login
router.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    if (!ADMIN_PASSWORD_HASH) {
        console.error('Authentication error: ADMIN_PASSWORD_HASH is not configured in environment variables.');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    if (username === ADMIN_USERNAME && bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
        req.session.authenticated = true;
        return res.status(200).json({ success: true, message: 'Logged in successfully' });
    } else {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    req.session = null;
    res.status(200).json({ success: true, message: 'Logged out successfully' });
});

// GET /api/auth/status - to check if logged in from frontend
router.get('/status', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.status(200).json({ authenticated: true });
    } else {
        res.status(200).json({ authenticated: false });
    }
});

module.exports = router;
