const { createClient } = require('@libsql/client');
const client = createClient({ url: 'file:new-database.sqlite' });
async function test() {
  await client.execute("CREATE TABLE redirects (id INTEGER PRIMARY KEY, alias TEXT);");
  await client.execute({ sql: "INSERT INTO redirects (alias) VALUES (?)", args: ['hello'] });
  const rs = await client.execute("SELECT * FROM redirects;");
  console.log(rs.rows);
}
test().catch(console.error);
