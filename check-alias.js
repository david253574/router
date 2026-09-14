const db = require('./database');
db.get("SELECT * FROM redirects WHERE alias = 'hghgh'", (err, row) => {
    console.log(err || row);
    process.exit(0);
});
