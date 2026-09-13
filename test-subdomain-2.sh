#!/bin/bash
export REDIRECT_BASE_DOMAIN=example.com
export NODE_ENV=development
export ADMIN_PASSWORD_HASH='$2b$10$tRM8v3g3p5q6WNQk35OnUefAWJHAdBTdBaCVUSlypvLYEov20FAmO'
export SESSION_SECRET='test'
export DATABASE_URL="file:./test-db.sqlite"
export DATABASE_AUTH_TOKEN=""

node server.js &
SERVER_PID=$!
sleep 2

echo "9. example.com.evil.com"
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: example.com.evil.com" http://localhost:3000/

kill $SERVER_PID
