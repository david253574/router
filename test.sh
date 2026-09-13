node server.js &
SERVER_PID=$!

# Wait for server to start
until curl -s http://localhost:3000/api/health > /dev/null; do
  sleep 1
done

echo "--- 1. Create redirect ---"
curl -s -X POST http://localhost:3000/api/redirects \
  -H "Content-Type: application/json" \
  -d '{"alias": "david", "destination_url": "https://logistic.vercel.app"}'

echo -e "\n\n--- 2. Confirm in SQLite ---"
sqlite3 database.sqlite "SELECT alias, destination_url, active FROM redirects WHERE alias='david';"

echo -e "\n\n--- 3/4/5. GET /r/david (checking 302 and Location) ---"
curl -s -I http://localhost:3000/r/david | grep -E "HTTP/|Location:"

echo -e "\n\n--- 6. Test invalid URL ---"
curl -s -X POST http://localhost:3000/api/redirects \
  -H "Content-Type: application/json" \
  -d '{"alias": "badurl", "destination_url": "javascript:alert(1)"}'

echo -e "\n\n--- 7. Test duplicate alias ---"
curl -s -X POST http://localhost:3000/api/redirects \
  -H "Content-Type: application/json" \
  -d '{"alias": "david", "destination_url": "https://google.com"}'

echo -e "\n\n--- 8. Test nonexistent alias ---"
curl -s -I http://localhost:3000/r/nonexistent | grep -E "HTTP/|404"

echo -e "\n\n--- 9. Test disabling a redirect ---"
ID=$(sqlite3 database.sqlite "SELECT id FROM redirects WHERE alias='david';")
curl -s -X PATCH http://localhost:3000/api/redirects/$ID \
  -H "Content-Type: application/json" \
  -d '{"active": false}'
echo -e "\nAfter disable, GET /r/david:"
curl -s -I http://localhost:3000/r/david | grep HTTP/

echo -e "\n\n--- 11. Test expired redirect ---"
curl -s -X PATCH http://localhost:3000/api/redirects/$ID \
  -H "Content-Type: application/json" \
  -d '{"active": true, "expires_at": "2020-01-01T00:00:00Z"}'
echo -e "\nAfter expire, GET /r/david:"
curl -s -I http://localhost:3000/r/david | grep HTTP/

echo -e "\n\n--- 10. Test deleting redirect ---"
curl -s -X DELETE http://localhost:3000/api/redirects/$ID
echo -e "\nAfter delete, SQLite count:"
sqlite3 database.sqlite "SELECT COUNT(*) FROM redirects WHERE alias='david';"

kill $SERVER_PID
