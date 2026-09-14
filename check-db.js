const db = require('./database');
db.get("SELECT * FROM redirects WHERE alias = 'testbot'", (err, row) => {
    console.log(err || row);
    process.exit(0);
});
