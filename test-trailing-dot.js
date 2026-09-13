const express = require('express');
const app = express();
app.use((req, res) => res.send(req.hostname));
app.listen(3001, () => {
    const { exec } = require('child_process');
    exec('curl -H "Host: valid-alias.example.com." http://localhost:3001', (err, stdout) => {
        console.log('Hostname received by express:', stdout);
        process.exit(0);
    });
});
