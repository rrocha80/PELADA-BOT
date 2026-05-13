// ...existing code...
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./pelada.db');
db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS participantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT UNIQUE
    )
  `);
});
// export default para compatibilidade com import padrão em TS/ESM
export default db;
