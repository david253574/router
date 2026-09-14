const db = require('./database');
db.run("DELETE FROM alias_sessions WHERE alias = 'testbot'", (err) => {
    db.run("INSERT OR IGNORE INTO redirects (alias, destination_url, active) VALUES (?, ?, ?)", ['testbot', 'https://example.com', 1], (err) => {
        if (err) console.error("Setup error:", err.message);
        else console.log("Test alias 'testbot' reset and prepared.");
        process.exit(0);
    });
});
