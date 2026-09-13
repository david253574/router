require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');
const path = require('path');

const oldDb = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

const dbUrl = process.env.DATABASE_URL || 'file:' + path.join(__dirname, 'vercel-database.sqlite');
const dbToken = process.env.DATABASE_AUTH_TOKEN;

const newClient = createClient({ url: dbUrl, authToken: dbToken });

async function migrate() {
    console.log('Starting migration to libSQL / Vercel-compatible DB...');
    
    // Create new schema
    await newClient.execute(`
        CREATE TABLE IF NOT EXISTS redirects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alias TEXT UNIQUE NOT NULL,
            destination_url TEXT NOT NULL,
            active INTEGER DEFAULT 1,
            expires_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Fetch old records
    oldDb.all("SELECT * FROM redirects", async (err, rows) => {
        if (err) {
            console.error('Failed to read from SQLite:', err);
            process.exit(1);
        }
        
        console.log(`Found ${rows.length} records in old database.`);
        
        let inserted = 0;
        for (const row of rows) {
            try {
                // Check if already exists to avoid unique constraint errors breaking the batch
                const existing = await newClient.execute({
                    sql: "SELECT id FROM redirects WHERE alias = ?",
                    args: [row.alias]
                });
                
                if (existing.rows.length === 0) {
                    await newClient.execute({
                        sql: "INSERT INTO redirects (id, alias, destination_url, active, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        args: [row.id, row.alias, row.destination_url, row.active, row.expires_at, row.created_at, row.updated_at]
                    });
                    inserted++;
                } else {
                    console.log(`Alias '${row.alias}' already exists in new DB, skipping.`);
                }
            } catch(e) {
                console.error('Insert error:', e.message);
            }
        }
        
        const res = await newClient.execute("SELECT COUNT(*) as count FROM redirects");
        console.log(`Migration complete. Inserted ${inserted} records.`);
        console.log(`New database total record count: ${res.rows[0].count}`);
        
        oldDb.close();
        newClient.close();
    });
}

migrate();
