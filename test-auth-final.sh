#!/bin/bash
export REDIRECT_BASE_DOMAIN=example.com
export NODE_ENV=development
export ADMIN_PASSWORD_HASH='$2b$10$tRM8v3g3p5q6WNQk35OnUefAWJHAdBTdBaCVUSlypvLYEov20FAmO'
export SESSION_SECRET='test'
export DATABASE_URL="file:./test-db.sqlite"

node server.js &
SERVER_PID=$!
sleep 2

echo "Auth Test: POST /api/auth/login"
curl -s -i -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin", "password":"password"}' | grep HTTP

kill $SERVER_PID
