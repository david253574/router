#!/bin/bash
export REDIRECT_BASE_DOMAIN=example.com
export NODE_ENV=development
export ADMIN_PASSWORD_HASH='$2b$10$tRM8v3g3p5q6WNQk35OnUefAWJHAdBTdBaCVUSlypvLYEov20FAmO'
export SESSION_SECRET='test'
export DATABASE_URL="file:./test-db.sqlite"
export DATABASE_AUTH_TOKEN=""
rm -f test-db.sqlite

node server.js &
SERVER_PID=$!
sleep 2

# Insert test data
sqlite3 test-db.sqlite "INSERT INTO redirects (alias, destination_url, active) VALUES ('valid-alias', 'https://google.com', 1);"
sqlite3 test-db.sqlite "INSERT INTO redirects (alias, destination_url, active) VALUES ('disabled-alias', 'https://google.com', 0);"
sqlite3 test-db.sqlite "INSERT INTO redirects (alias, destination_url, active, expires_at) VALUES ('expired-alias', 'https://google.com', 1, '2000-01-01T00:00:00.000Z');"

echo "1. /r/valid-alias"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/r/valid-alias

echo "2. /r/missing-alias"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/r/missing-alias

echo "3. /r/disabled-alias"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/r/disabled-alias

echo "4. /r/expired-alias"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/r/expired-alias

echo "5. valid-alias.example.com"
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: valid-alias.example.com" http://localhost:3000/

echo "6. missing-alias.example.com"
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: missing-alias.example.com" http://localhost:3000/

echo "7. invalid hostname (evil.com.example.com)"
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: evil.com.example.com" http://localhost:3000/

echo "8. API health"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health

kill $SERVER_PID
