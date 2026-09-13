npm start > /dev/null 2>&1 &
SERVER_PID=$!

echo "Waiting for server..."
until curl -s http://localhost:3000/api/health > /dev/null; do sleep 1; done
echo "Server up!"

echo -e "\n=== HEALTH ==="
curl -s -i http://localhost:3000/api/health | head -n 1

echo -e "\n=== AUTHENTICATION ==="
curl -s -o /dev/null -w "Unauth request: %{http_code}\n" http://localhost:3000/api/redirects
curl -s -o /dev/null -w "Invalid login: %{http_code}\n" -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin", "password":"wrong"}'
curl -s -c cookies.txt -o /dev/null -w "Valid login: %{http_code}\n" -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin", "password":"password"}'
curl -s -b cookies.txt -o /dev/null -w "Status check: %{http_code}\n" http://localhost:3000/api/auth/status
curl -s -b cookies.txt -o /dev/null -w "Auth request: %{http_code}\n" http://localhost:3000/api/redirects

echo -e "\n=== TEMPORARY REDIRECT TEST (Part 20) ==="
curl -s -b cookies.txt -o /dev/null -w "Auth create step6-test: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"step6-test", "destination_url":"https://example.com"}'
echo "Public redirect:"
curl -s -i http://localhost:3000/r/step6-test | grep -E "HTTP/|Location:"

# Fetch ID for step6-test to delete it
ID=$(node -e "require('@libsql/client').createClient({url:'file:vercel-database.sqlite'}).execute('SELECT id FROM redirects WHERE alias=\'step6-test\'').then(rs => console.log(rs.rows[0].id))")
curl -s -b cookies.txt -o /dev/null -w "Auth delete step6-test: %{http_code}\n" -X DELETE http://localhost:3000/api/redirects/$ID

echo -e "\n=== EXISTING REDIRECT TEST ==="
echo "Public redirect for existing record (david, expired):"
curl -s -i http://localhost:3000/r/david | grep -E "HTTP/|Location:"

echo -e "\n=== VALIDATION & SECURITY ==="
curl -s -b cookies.txt -o /dev/null -w "Invalid URL: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"test2", "destination_url":"invalid"}'
curl -s -b cookies.txt -o /dev/null -w "Invalid alias: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"test space", "destination_url":"https://example.com"}'
curl -s -o /dev/null -w "/.env: %{http_code}\n" http://localhost:3000/.env
curl -s -o /dev/null -w "Malformed JSON: %{http_code}\n" -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"user"'

echo -e "\n=== LOGOUT ==="
curl -s -b cookies.txt -c cookies.txt -o /dev/null -w "Logout: %{http_code}\n" -X POST http://localhost:3000/api/auth/logout
curl -s -b cookies.txt -o /dev/null -w "Old session access: %{http_code}\n" http://localhost:3000/api/redirects

kill -SIGTERM $SERVER_PID
