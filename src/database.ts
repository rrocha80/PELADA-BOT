import sqlite3pkg from 'sqlite3';

const sqlite3 = (sqlite3pkg as any).verbose();

const db = new sqlite3.Database('./pelada.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS participantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT UNIQUE
    )
  `);

  // nova tabela para convidados
  db.run(`
    CREATE TABLE IF NOT EXISTS convidados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      convidado_por TEXT
    )
  `);
});

export default db;