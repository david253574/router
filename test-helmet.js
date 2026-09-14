const express = require('express');
const helmet = require('helmet');
const app = express();
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"]
        }
    }
}));
app.get('/', (req, res) => {
    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');
    res.send('ok');
});
const server = app.listen(3001, async () => {
    
    const r = await fetch('http://localhost:3001/');
    console.log("CSP:", r.headers.get('content-security-policy'));
    console.log("XFO:", r.headers.get('x-frame-options'));
    server.close();
});
