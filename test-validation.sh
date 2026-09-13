npm start > /dev/null 2>&1 &
SERVER_PID=$!

until curl -s http://localhost:3000/api/health > /dev/null; do sleep 1; done

curl -s -c cookies.txt -o /dev/null -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin", "password":"password"}'

echo -e "\n=== VALIDATION ==="
curl -s -b cookies.txt -o /dev/null -w "Invalid URL: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"test", "destination_url":"invalid"}'
curl -s -b cookies.txt -o /dev/null -w "Dangerous scheme: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"test", "destination_url":"javascript:alert(1)"}'
curl -s -b cookies.txt -o /dev/null -w "Invalid alias: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"te st", "destination_url":"https://example.com"}'

echo -e "\n=== SECURITY ==="
curl -s -b cookies.txt -o /dev/null -w "SQL Injection Alias: %{http_code}\n" -X POST http://localhost:3000/api/redirects -H "Content-Type: application/json" -d '{"alias":"\" OR 1=1;--", "destination_url":"https://example.com"}'

kill -SIGTERM $SERVER_PID
