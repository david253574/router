node server.js &
SERVER_PID=$!

echo "Waiting for server to start..."
until curl -s http://localhost:3000/api/health > /dev/null; do
  sleep 1
done
echo "Server up!"

echo -e "\n=== A. Health ==="
curl -s -i http://localhost:3000/api/health | head -n 1

echo -e "\n=== B. Valid redirect ==="
curl -s -X POST http://localhost:3000/api/redirects \
  -H "Content-Type: application/json" \
  -d '{"alias": "david", "destination_url": "https://logistic.vercel.app"}' > /dev/null
curl -s -i http://localhost:3000/r/david | grep -E "HTTP/|Location:"

echo -e "\n=== C. Dangerous destination schemes ==="
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias": "bad1", "destination_url": "javascript:alert(1)"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias": "bad2", "destination_url": "data:text/html,test"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias": "bad3", "destination_url": "file:///etc/passwd"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias": "bad4", "destination_url": "ftp://example.com"}'

echo -e "\n=== D. Invalid aliases ==="
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias": "da vid", "destination_url": "https://example.com"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias": "da/vid", "destination_url": "https://example.com"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias": "da?vid", "destination_url": "https://example.com"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias": "da#vid", "destination_url": "https://example.com"}'
LONG_ALIAS=$(head -c 150 /dev/zero | tr '\0' 'a')
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias": "'$LONG_ALIAS'", "destination_url": "https://example.com"}'

echo -e "\n=== E. Malformed API input ==="
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"david2"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":123,"destination_url":"https://example.com"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{invalid_json'

echo -e "\n=== F. SQL/input robustness ==="
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias": "\" OR 1=1;--", "destination_url": "https://example.com"}'
curl -s -I http://localhost:3000/api/health | head -n 1

echo -e "\n=== G. Missing redirect ==="
curl -s -I http://localhost:3000/r/does-not-exist | head -n 1

echo -e "\n=== H. Disabled redirect ==="
ID=$(sqlite3 database.sqlite "SELECT id FROM redirects WHERE alias='david';")
curl -s -X PATCH http://localhost:3000/api/redirects/$ID -H "Content-Type: application/json" -d '{"active": false}' > /dev/null
curl -s -I http://localhost:3000/r/david | head -n 1

echo -e "\n=== I. Expired redirect ==="
curl -s -X PATCH http://localhost:3000/api/redirects/$ID -H "Content-Type: application/json" -d '{"active": true, "expires_at": "2020-01-01T00:00:00Z"}' > /dev/null
curl -s -I http://localhost:3000/r/david | head -n 1

echo -e "\n=== J. Sensitive-file exposure ==="
curl -s -o /dev/null -w "/.env: %{http_code}\n" http://localhost:3000/.env
curl -s -o /dev/null -w "/database.sqlite: %{http_code}\n" http://localhost:3000/database.sqlite
curl -s -o /dev/null -w "/server.js: %{http_code}\n" http://localhost:3000/server.js
curl -s -o /dev/null -w "/database.js: %{http_code}\n" http://localhost:3000/database.js

kill $SERVER_PID
sleep 2

echo -e "\n=== K. Restart test ==="
node server.js &
SERVER_PID2=$!
sleep 2
curl -s -I http://localhost:3000/api/health | head -n 1
kill $SERVER_PID2
