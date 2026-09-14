const path = require('path');
require('dotenv').config();
const { createClient } = require('@libsql/client');

// Use Vercel Edge / Turso compatible DB url. Defaults to local vercel-database.sqlite for testing.
const dbUrl = process.env.DATABASE_URL || 'file:' + path.join(__dirname, 'vercel-database.sqlite');
const dbToken = process.env.DATABASE_AUTH_TOKEN;

const client = createClient({
    url: dbUrl,
    authToken: dbToken
});

console.log(`Connected to libSQL/Turso database: ${dbUrl}`);

// Create an adapter that mimics the 'sqlite3' API for compatibility with existing routes
const db = {
    serialize: (cb) => {
        // libSQL executes sequentially in async contexts
        if (cb) cb();
    },
    run: async (sql, params = [], cb) => {
        if (typeof params === 'function') {
            cb = params;
            params = [];
        }
        try {
            // Convert undefined parameters to null for libSQL compatibility
            const safeParams = params.map(p => p === undefined ? null : p);
            const rs = await client.execute({ sql, args: safeParams });
            if (cb) cb.call({ lastID: rs.lastInsertRowid ? Number(rs.lastInsertRowid) : undefined, changes: rs.rowsAffected }, null);
        } catch (err) {
            if (cb) cb(err);
        }
        return db;
    },
    get: async (sql, params = [], cb) => {
        if (typeof params === 'function') {
            cb = params;
            params = [];
        }
        try {
            const safeParams = params.map(p => p === undefined ? null : p);
            const rs = await client.execute({ sql, args: safeParams });
            if (cb) cb(null, rs.rows.length > 0 ? rs.rows[0] : undefined);
        } catch (err) {
            if (cb) cb(err);
        }
        return db;
    },
    all: async (sql, params = [], cb) => {
        if (typeof params === 'function') {
            cb = params;
            params = [];
        }
        try {
            const safeParams = params.map(p => p === undefined ? null : p);
            const rs = await client.execute({ sql, args: safeParams });
            if (cb) cb(null, rs.rows);
        } catch (err) {
            if (cb) cb(err);
        }
        return db;
    },
    closeGracefully: (cb) => {
        try {
            client.close();
            console.log('libSQL database connection closed.');
            if (cb) cb(null);
        } catch (err) {
            console.error('Error closing database:', err.message);
            if (cb) cb(err);
        }
    }
};

// Initialize table
db.run(`
    CREATE TABLE IF NOT EXISTS redirects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT UNIQUE NOT NULL,
        destination_url TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`, (err) => {
    if (err) console.error('Error creating table:', err.message);
});

// Session-binding table for the wildcard-subdomain one-user-per-link policy
db.run(`
    CREATE TABLE IF NOT EXISTS alias_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT UNIQUE NOT NULL,
        session_token TEXT UNIQUE NOT NULL,
        client_sig TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`, (err) => {
    if (err) console.error('Error creating alias_sessions table:', err.message);
});

module.exports = db;
