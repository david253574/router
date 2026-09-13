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

sqlite3 test-db.sqlite "CREATE TABLE redirects (id INTEGER PRIMARY KEY AUTOINCREMENT, alias TEXT UNIQUE NOT NULL, destination_url TEXT NOT NULL, active INTEGER DEFAULT 1, expires_at DATETIME);"
sqlite3 test-db.sqlite "INSERT INTO redirects (alias, destination_url, active) VALUES ('up', 'https://logistics-iota-seven.vercel.app/admin.html', 1);"

echo "Test alias sub-domain: up.example.com"
curl -s -i -H "Host: up.example.com" http://localhost:3000/ | grep HTTP

kill $SERVER_PID
