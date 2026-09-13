const bcrypt = require('bcryptjs');
const hash = process.env.ADMIN_PASSWORD_HASH || "$2b$10$E7xqAKFx6xr6xFMF18odwuOMy7BRLzyEDAsGx0VYfBvurI0Gub9ce";
console.log("password:", bcrypt.compareSync("password", hash));
console.log("admin:", bcrypt.compareSync("admin", hash));
console.log("admin123:", bcrypt.compareSync("admin123", hash));
console.log("david:", bcrypt.compareSync("david", hash));
