const http = require('http');
const { spawn } = require('child_process');

// 1. Boot Server
const serverProcess = spawn('node', ['server.js'], { env: { ...process.env, NODE_ENV: 'development' } });

let serverReady = false;

serverProcess.stdout.on('data', (data) => {
    const out = data.toString();
    process.stdout.write('[SERVER INFO] ' + out);
    if (out.includes('Server is running on port 3000')) {
        serverReady = true;
        runTests();
    }
});

serverProcess.stderr.on('data', (data) => {
    process.stdout.write('[SERVER ERR] ' + data.toString());
});

async function requestVector(name, headers) {
    console.log(`\n--- Executing ${name} ---`);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: 3000,
            path: '/',
            method: 'GET',
            headers: headers
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function runTests() {
    try {
        let cookieStore = '';

        // Vector 1 (Bot Interception Simulation)
        // sqlmap signature
        const v1 = await requestVector('Vector 1 (Bot Interception Simulation)', {
            'Host': 'testbot.localhost',
            'User-Agent': 'sqlmap/1.8'
        });
        console.log(`Vector 1 Received Status: ${v1.status}`);
        if (v1.status === 403) {
            console.log("SUCCESS: Bot correctly blocked with 403 Forbidden.");
        } else {
            console.error("FAIL: Expected 403, got", v1.status);
        }

        // Vector 2 (Baseline Identity Lock Simulation)
        // Clean mobile residential signature
        const v2Headers = {
            'Host': 'testbot.localhost',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Forwarded-For': '192.168.1.50' // mock residential
        };
        const v2 = await requestVector('Vector 2 (Baseline Identity Lock Simulation)', v2Headers);
        console.log(`Vector 2 Received Status: ${v2.status}`);
        
        // Extract the Set-Cookie token
        const setCookie = v2.headers['set-cookie'];
        if (setCookie) {
            cookieStore = setCookie.find(c => c.includes('_rsid='));
            if (cookieStore) cookieStore = cookieStore.split(';')[0];
        }

        if (v2.status === 200 && cookieStore) {
            console.log("SUCCESS: Clean residential hit succeeded (200 OK) and issued session token.");
        } else {
            console.error("FAIL: Expected 200 and a token cookie. Status:", v2.status, "Cookie:", cookieStore);
        }

        // Vector 3 (Authorized Lifecycle Validation)
        // Exact same signature, with token
        const v3Headers = { ...v2Headers, 'Cookie': cookieStore };
        const v3 = await requestVector('Vector 3 (Authorized Lifecycle Validation)', v3Headers);
        console.log(`Vector 3 Received Status: ${v3.status}`);
        if (v3.status === 200) {
            console.log("SUCCESS: Authorized follow-up succeeded (200 OK).");
        } else {
            console.error("FAIL: Expected 200, got", v3.status);
        }

        // Vector 4 (Analyst Profiling & Circuit Break Simulation)
        // Altered signature, no token
        const v4Headers = {
            'Host': 'testbot.localhost',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36', 'sec-ch-ua': '"Not.A/Brand";v="8", "Chromium";v="114", "Google Chrome";v="114"', 'Accept-Language': 'en-US,en;q=0.9',
            'X-Forwarded-For': '192.168.1.50'
        };
        const v4 = await requestVector('Vector 4 (Analyst Profiling & Circuit Break Simulation)', v4Headers);
        console.log(`Vector 4 Received Status: ${v4.status}`);
        if (v4.status === 404) {
            console.log("SUCCESS: Device mismatch/missing token generated 404 Not Found circuit break.");
        } else {
            console.error("FAIL: Expected 404, got", v4.status);
        }

    } catch (err) {
        console.error("Error during test execution:", err);
    } finally {
        console.log("\nTests complete. Shutting down server...");
        serverProcess.kill('SIGTERM');
        process.exit(0);
    }
}
