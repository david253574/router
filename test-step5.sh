echo "=== PRE-TEST DB COUNT ==="
PRE_COUNT=$(sqlite3 database.sqlite "SELECT COUNT(*) FROM redirects;")
echo "Initial redirects count: $PRE_COUNT"

echo -e "\n=== STARTUP VALIDATION TEST ==="
# Should fail because secrets are removed temporarily
NODE_ENV=production SESSION_SECRET= ADMIN_PASSWORD_HASH= node server.js > start_fail.log 2>&1
grep "Missing required environment variable" start_fail.log

echo -e "\n=== STARTING APPLICATION ==="
npm start &
SERVER_PID=$!

echo "Waiting for server..."
until curl -s http://localhost:3000/api/health > /dev/null; do sleep 1; done
echo "Server up!"

echo -e "\n=== HEALTH ==="
curl -s -i http://localhost:3000/api/health | head -n 1

echo -e "\n=== AUTHENTICATION ==="
curl -s -o /dev/null -w "Unauth request: %{http_code}\n" http://localhost:3000/api/redirects
curl -s -o /dev/null -w "Invalid login: %{http_code}\n" -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin", "password":"wrongpassword"}'
curl -s -c cookies.txt -o /dev/null -w "Valid login: %{http_code}\n" -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin", "password":"password"}'
curl -s -b cookies.txt -o /dev/null -w "Auth request: %{http_code}\n" http://localhost:3000/api/redirects

echo -e "\n=== CREATING step5-test ==="
curl -s -b cookies.txt -o /dev/null -w "Auth create: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"step5-test", "destination_url":"https://example.com"}'

echo -e "\n=== PUBLIC REDIRECT ==="
curl -s -i http://localhost:3000/r/step5-test | grep -E "HTTP/|Location:"

echo -e "\n=== DELETING step5-test ==="
ID=$(sqlite3 database.sqlite "SELECT id FROM redirects WHERE alias='step5-test';")
curl -s -b cookies.txt -o /dev/null -w "Auth delete: %{http_code}\n" -X DELETE http://localhost:3000/api/redirects/$ID

echo -e "\n=== LOGOUT ==="
curl -s -b cookies.txt -o /dev/null -w "Logout: %{http_code}\n" -X POST http://localhost:3000/api/auth/logout
curl -s -b cookies.txt -o /dev/null -w "Old session access: %{http_code}\n" http://localhost:3000/api/redirects

echo -e "\n=== VALIDATION ==="
curl -s -b cookies.txt -o /dev/null -w "Invalid URL: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"test", "destination_url":"invalid"}'
curl -s -b cookies.txt -o /dev/null -w "Dangerous scheme: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"test", "destination_url":"javascript:alert(1)"}'
curl -s -b cookies.txt -o /dev/null -w "Invalid alias: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"te st", "destination_url":"https://example.com"}'

echo -e "\n=== SECURITY ==="
curl -s -o /dev/null -w "/.env: %{http_code}\n" http://localhost:3000/.env
curl -s -o /dev/null -w "/server.js: %{http_code}\n" http://localhost:3000/server.js
curl -s -o /dev/null -w "Malformed JSON: %{http_code}\n" -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"user"'
curl -s -o /dev/null -w "SQL Injection Alias: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"\" OR 1=1;--", "destination_url":"https://example.com"}'

echo -e "\n=== GRACEFUL SHUTDOWN ==="
kill -SIGTERM $SERVER_PID
sleep 3
# Wait for node to cleanly exit
wait $SERVER_PID

echo -e "\n=== RESTART ==="
npm start &
SERVER_PID2=$!
sleep 2
curl -s -o /dev/null -w "Health check after restart: %{http_code}\n" http://localhost:3000/api/health
kill -SIGTERM $SERVER_PID2

echo -e "\n=== POST-TEST DB COUNT ==="
POST_COUNT=$(sqlite3 database.sqlite "SELECT COUNT(*) FROM redirects;")
echo "Final redirects count: $POST_COUNT"
