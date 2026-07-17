const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs'); // Добавлено для проверки и создания папки

class Database {
  constructor() {
    // Путь к папке data (как в предоставленном отрывке)
    const dataDir = '/app/data';
    
    // Создаем папку, если её нет (рекурсивно)
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Путь к базе данных
    this.dbPath = path.join(dataDir, 'bot.db');

    this.db = new sqlite3.Database(this.dbPath, (err) => {
      if (err) {
        console.error('❌ Ошибка открытия базы данных:', err.message);
      } else {
        console.log(`✅ База данных подключена: ${this.dbPath}`);
        this.initTables();
      }
    });
  }

  initTables() {
    // Объединяем вашу новую таблицу users с существующими таблицами
    const sql = `
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        command TEXT,
        output TEXT,
        status TEXT
      );
      
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        size INTEGER
      );
      
      CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        exit_code INTEGER
      );
    `;
    
    this.db.exec(sql, (err) => {
      if (err) {
        console.error('❌ Ошибка создания таблиц:', err.message);
      } else {
        console.log('✅ Таблицы созданы или уже существуют');
      }
    });
  }

  query(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        this.db.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      } else {
        this.db.run(sql, params, function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes, lastID: this.lastID });
        });
      }
    });
  }

  logCommand(command, output, status) {
    const sql = 'INSERT INTO commands (command, exit_code) VALUES (?, ?)';
    const exitCode = status === 'success' ? 0 : 1;
    return this.query(sql, [command, exitCode]).catch(console.error);
  }

  close() {
    return new Promise((resolve) => {
      this.db.close((err) => {
        if (err) console.error('❌ Ошибка закрытия БД:', err.message);
        resolve();
      });
    });
  }
}

module.exports = Database;
