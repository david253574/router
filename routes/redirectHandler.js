const db = require('../database');

function handleRedirect(alias, res) {
    db.get(`SELECT destination_url, active, expires_at FROM redirects WHERE alias = ?`, [alias], (err, row) => {
        if (err) {
            console.error('Database error:', err.message);
            return res.status(500).send('Internal Server Error');
        }

        if (!row) {
            return res.status(404).send('Redirect not found');
        }

        if (!row.active) {
            return res.status(403).send('This redirect is disabled.');
        }

        if (row.expires_at) {
            const now = new Date();
            const expires = new Date(row.expires_at);
            if (now > expires) {
                return res.status(410).send('This redirect has expired.');
            }
        }

        // Genuine HTTP 302 Redirect
        res.redirect(302, row.destination_url);
    });
}

module.exports = { handleRedirect };
