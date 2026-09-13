node server.js &
SERVER_PID=$!

echo "Waiting for server..."
until curl -s http://localhost:3000/api/health > /dev/null; do sleep 1; done
echo "Server up!"

# Insert a test redirect for public access testing
sqlite3 database.sqlite "INSERT INTO redirects (alias, destination_url) VALUES ('david', 'https://logistic.vercel.app');"

echo -e "\n=== A. Health ==="
curl -s -i http://localhost:3000/api/health | head -n 1

echo -e "\n=== B. Public redirect ==="
curl -s -i http://localhost:3000/r/david | grep -E "HTTP/|Location:"

echo -e "\n=== C. Unauthenticated redirect listing ==="
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/redirects

echo -e "\n=== D. Unauthenticated creation ==="
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"test1", "destination_url":"https://test.com"}'

echo -e "\n=== E. Unauthenticated update ==="
ID=$(sqlite3 database.sqlite "SELECT id FROM redirects WHERE alias='david';")
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH http://localhost:3000/api/redirects/$ID -H "Content-Type: application/json" -d '{"active":false}'

echo -e "\n=== F. Unauthenticated deletion ==="
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE http://localhost:3000/api/redirects/$ID

echo -e "\n=== G. Invalid login ==="
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin", "password":"wrongpassword"}'

echo -e "\n=== H. Valid login ==="
curl -s -i -c cookies.txt -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin", "password":"password"}' | grep -E "HTTP/|Set-Cookie"

echo -e "\n=== I. Authenticated listing ==="
curl -s -b cookies.txt -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/redirects

echo -e "\n=== J. Authenticated creation ==="
curl -s -b cookies.txt -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"test-auth", "destination_url":"https://example.com"}'

echo -e "\n=== K. Authenticated update ==="
NEW_ID=$(sqlite3 database.sqlite "SELECT id FROM redirects WHERE alias='test-auth';")
curl -s -b cookies.txt -o /dev/null -w "%{http_code}\n" -X PATCH http://localhost:3000/api/redirects/$NEW_ID -H "Content-Type: application/json" -d '{"active":false}'

echo -e "\n=== L. Authenticated deletion ==="
curl -s -b cookies.txt -o /dev/null -w "%{http_code}\n" -X DELETE http://localhost:3000/api/redirects/$NEW_ID

echo -e "\n=== M. Logout ==="
curl -s -b cookies.txt -c cookies.txt -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/auth/logout

echo -e "\n=== N. Access after logout ==="
curl -s -b cookies.txt -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/redirects

echo -e "\n=== O. Public redirect after logout ==="
curl -s -i http://localhost:3000/r/david | grep -E "HTTP/|Location:"

echo -e "\n=== P. Sensitive files ==="
curl -s -o /dev/null -w "/.env: %{http_code}\n" http://localhost:3000/.env
curl -s -o /dev/null -w "/database.sqlite: %{http_code}\n" http://localhost:3000/database.sqlite

kill $SERVER_PID
sleep 2

echo -e "\n=== Q. Restart test ==="
node server.js &
SERVER_PID2=$!
sleep 2
curl -s -o /dev/null -w "/api/health: %{http_code}\n" http://localhost:3000/api/health
kill $SERVER_PID2
