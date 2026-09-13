const express = require('express');
const router = express.Router();
const db = require('../database');

const RESERVED_ALIASES = ['api', 'r', 'favicon.ico'];
const ALIAS_REGEX = /^[a-zA-Z0-9\-_]+$/;

function validateAlias(alias) {
    if (!alias || typeof alias !== 'string') return 'Alias is required and must be a string';
    if (alias.trim() === '') return 'Alias cannot be empty';
    if (alias.length > 100) return 'Alias must be 100 characters or less';
    if (!ALIAS_REGEX.test(alias)) return 'Alias can only contain letters, numbers, hyphens, and underscores';
    if (RESERVED_ALIASES.includes(alias.toLowerCase())) return 'Alias is reserved';
    return null;
}

function validateUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return 'Destination URL is required and must be a string';
    if (urlStr.trim() === '') return 'Destination URL cannot be empty';
    try {
        const u = new URL(urlStr);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return 'Destination URL must use http:// or https://';
        }
    } catch (e) {
        return 'Invalid destination URL';
    }
    return null;
}

function validateId(id) {
    const num = parseInt(id, 10);
    if (isNaN(num) || num <= 0) return 'Invalid ID';
    return null;
}

// Health check
router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Config check for UI
router.get('/config', (req, res) => {
    res.json({ 
        baseDomain: process.env.REDIRECT_BASE_DOMAIN || null,
        isLocal: process.env.NODE_ENV !== 'production'
    });
});

// Create a new redirect
router.post('/redirects', (req, res) => {
    // Only extract expected fields
    const alias = req.body.alias;
    const destination_url = req.body.destination_url;
    const expires_at = req.body.expires_at;

    if (Object.keys(req.body).length === 0) {
        return res.status(400).json({ error: 'Payload cannot be empty' });
    }
    
    const aliasError = validateAlias(alias);
    if (aliasError) return res.status(400).json({ error: aliasError });
    
    const urlError = validateUrl(destination_url);
    if (urlError) return res.status(400).json({ error: urlError });

    const active = 1;
    let expiresAtValid = null;
    if (expires_at !== undefined && expires_at !== null && expires_at !== '') {
        const parsedDate = new Date(expires_at);
        if (isNaN(parsedDate.getTime())) {
            return res.status(400).json({ error: 'Invalid expires_at date format' });
        }
        expiresAtValid = parsedDate.toISOString();
    }

    const query = `INSERT INTO redirects (alias, destination_url, active, expires_at) VALUES (?, ?, ?, ?)`;
    db.run(query, [alias, destination_url, active, expiresAtValid], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ error: 'Alias already exists' });
            }
            return res.status(500).json({ error: 'Database error' });
        }
        
        let redirectUrl = `${req.protocol}://${req.get('host')}/r/${alias}`;
        const baseDomain = process.env.REDIRECT_BASE_DOMAIN;
        if (baseDomain) {
            redirectUrl = `${req.protocol}://${alias}.${baseDomain}`;
        } else if (process.env.NODE_ENV !== 'production' && req.get('host').includes('localhost')) {
            redirectUrl = `${req.protocol}://${alias}.localhost:${req.get('host').split(':')[1] || 3000}`;
        }

        res.status(201).json({
            success: true,
            redirect: {
                id: this.lastID,
                alias,
                destination_url,
                active: true,
                expires_at: expiresAtValid,
            },
            redirect_url: redirectUrl
        });
    });
});

// Get all redirects for management
router.get('/redirects', (req, res) => {
    db.all(`SELECT * FROM redirects ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        const redirects = rows.map(r => {
            let redirectUrl = `${req.protocol}://${req.get('host')}/r/${r.alias}`;
            const baseDomain = process.env.REDIRECT_BASE_DOMAIN;
            if (baseDomain) {
                redirectUrl = `${req.protocol}://${r.alias}.${baseDomain}`;
            } else if (process.env.NODE_ENV !== 'production' && req.get('host').includes('localhost')) {
                redirectUrl = `${req.protocol}://${r.alias}.localhost:${req.get('host').split(':')[1] || 3000}`;
            }
            
            return {
                ...r,
                active: Boolean(r.active),
                redirect_url: redirectUrl
            };
        });
        res.json(redirects);
    });
});

// Delete a redirect
router.delete('/redirects/:id', (req, res) => {
    const id = req.params.id;
    const idError = validateId(id);
    if (idError) return res.status(400).json({ error: idError });

    db.run(`DELETE FROM redirects WHERE id = ?`, [id], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Redirect not found' });
        }
        res.status(200).json({ success: true, message: 'Redirect deleted' });
    });
});

// Update a redirect
router.patch('/redirects/:id', (req, res) => {
    const id = req.params.id;
    const idError = validateId(id);
    if (idError) return res.status(400).json({ error: idError });

    const destination_url = req.body.destination_url;
    const active = req.body.active;
    const expires_at = req.body.expires_at;
    
    if (Object.keys(req.body).length === 0) {
        return res.status(400).json({ error: 'Payload cannot be empty' });
    }

    const updates = [];
    const params = [];

    if (destination_url !== undefined) {
        const urlError = validateUrl(destination_url);
        if (urlError) return res.status(400).json({ error: urlError });
        updates.push('destination_url = ?');
        params.push(destination_url);
    }
    
    if (active !== undefined) {
        updates.push('active = ?');
        params.push(active ? 1 : 0);
    }

    if (expires_at !== undefined) {
        if (expires_at === null || expires_at === '') {
            updates.push('expires_at = ?');
            params.push(null);
        } else {
            const parsedDate = new Date(expires_at);
            if (isNaN(parsedDate.getTime())) {
                return res.status(400).json({ error: 'Invalid expires_at date format' });
            }
            updates.push('expires_at = ?');
            params.push(parsedDate.toISOString());
        }
    }

    if (updates.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    
    const query = `UPDATE redirects SET ${updates.join(', ')} WHERE id = ?`;
    
    db.run(query, params, function(err) {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Redirect not found' });
        }
        res.status(200).json({ success: true, message: 'Redirect updated' });
    });
});

module.exports = router;
