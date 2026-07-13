// Подключаем библиотеки sqlite3 и path
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Храним базу данных рядом с db.js, файл будет называться db.sqlite
const db = new sqlite3.Database(path.join(__dirname, 'db.sqlite'));

// Создаём таблицу задач, если её ещё нет
db.serialize(() => {
  
  db.run("PRAGMA encoding = 'UTF-8';", (err) => {
    if (err) console.error('Не удалось установить кодировку:', err);
    else console.log('Кодировка БД установлена на UTF-8');
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT DEFAULT 'author',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
    // Таблица рецензий на научные статьи (форма form.html)
    // Один пользователь может оценить конкретную работу только один раз —
    // это обеспечивается ограничением UNIQUE(work_id, expert_id).
    db.run(`
        CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            work_id INTEGER NOT NULL,
            expert_id INTEGER NOT NULL,
            profile_match TEXT NOT NULL,
            article_type TEXT NOT NULL,
            quality_1 TEXT,
            quality_2 TEXT,
            quality_3 TEXT,
            quality_4 TEXT,
            quality_5 TEXT,
            quality_6 TEXT,
            quality_7 TEXT,
            quality_8 TEXT,
            quality_9 TEXT,
            eval_1 INTEGER NOT NULL,
            eval_2 INTEGER NOT NULL,
            eval_3 INTEGER NOT NULL,
            publication_decision TEXT NOT NULL,
            justification TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(work_id, expert_id),
            FOREIGN KEY (work_id) REFERENCES works(id),
            FOREIGN KEY (expert_id) REFERENCES users(id)
        )
    `, (err) => {
        if (err) console.error('Ошибка создания reviews:', err.message);
        else console.log('Таблица reviews готова');
    });

    // Таблица для конкурсных работ (форма expert-assessment.html)
    // Аналогично: один пользователь может оценить конкретную работу только один раз.
    db.run(`
        CREATE TABLE IF NOT EXISTS expert_assessments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            work_id INTEGER NOT NULL,
            expert_id INTEGER NOT NULL,
            contestant_name TEXT NOT NULL,
            criteria_1 TEXT NOT NULL,
            criteria_2 TEXT NOT NULL,
            criteria_3 TEXT NOT NULL,
            criteria_4 TEXT NOT NULL,
            criteria_5 TEXT NOT NULL,
            criteria_6 TEXT NOT NULL,
            criteria_7 TEXT NOT NULL,
            criteria_8 TEXT NOT NULL,
            criteria_9 TEXT NOT NULL,
            criteria_10 TEXT NOT NULL,
            criteria_11 TEXT NOT NULL,
            resultativity INTEGER DEFAULT 0,
            operationality INTEGER DEFAULT 0,
            resource_intensity INTEGER DEFAULT 0,
            general_conclusion TEXT NOT NULL,
            commission_member TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(work_id, expert_id),
            FOREIGN KEY (work_id) REFERENCES works(id),
            FOREIGN KEY (expert_id) REFERENCES users(id)
        )
    `, (err) => {
        if (err) console.error('Ошибка создания expert_assessments:', err.message);
        else console.log('Таблица expert_assessments готова');
    });
  
});

db.run(`
  CREATE TABLE IF NOT EXISTS works (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`, (err) => {
  if (err) console.error('Ошибка создания таблицы works:', err.message);
  else console.log('Таблица works готова');
});

// ----- ЛЁГКАЯ МИГРАЦИЯ СТАРОЙ СХЕМЫ -----
// В более ранней версии проекта таблицы reviews/expert_assessments имели другие
// столбцы и/или другое ограничение уникальности (UNIQUE только по одной работе).
// Если в базе остались таблицы старого формата и они пусты — пересоздаём их
// с новой схемой (описанной выше). Если в них уже есть данные — ничего не трогаем
// и просто выводим предупреждение, чтобы не потерять данные случайно.
function migrateTableIfNeeded(tableName, expectedSqlFragment, createSql) {
    db.get(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?",
        [tableName],
        (err, row) => {
            if (err || !row) return; // таблицы ещё нет — её создаст CREATE TABLE выше
            if (row.sql.includes(expectedSqlFragment)) return; // уже новая схема

            db.get(`SELECT COUNT(*) AS cnt FROM ${tableName}`, [], (err2, countRow) => {
                if (err2) return;
                if (countRow.cnt > 0) {
                    console.warn(`⚠️  Таблица ${tableName} использует старую схему, но содержит данные (${countRow.cnt}) — авто-миграция пропущена.`);
                    return;
                }
                db.run(`DROP TABLE ${tableName}`, [], (err3) => {
                    if (err3) return console.error(`Не удалось удалить старую таблицу ${tableName}:`, err3.message);
                    db.run(createSql, [], (err4) => {
                        if (err4) console.error(`Не удалось пересоздать таблицу ${tableName}:`, err4.message);
                        else console.log(`🔄 Таблица ${tableName} мигрирована на новую схему`);
                    });
                });
            });
        }
    );
}

migrateTableIfNeeded('reviews', 'UNIQUE(work_id, expert_id)', `
    CREATE TABLE reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id INTEGER NOT NULL,
        expert_id INTEGER NOT NULL,
        profile_match TEXT NOT NULL,
        article_type TEXT NOT NULL,
        quality_1 TEXT,
        quality_2 TEXT,
        quality_3 TEXT,
        quality_4 TEXT,
        quality_5 TEXT,
        quality_6 TEXT,
        quality_7 TEXT,
        quality_8 TEXT,
        quality_9 TEXT,
        eval_1 INTEGER NOT NULL,
        eval_2 INTEGER NOT NULL,
        eval_3 INTEGER NOT NULL,
        publication_decision TEXT NOT NULL,
        justification TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(work_id, expert_id),
        FOREIGN KEY (work_id) REFERENCES works(id),
        FOREIGN KEY (expert_id) REFERENCES users(id)
    )
`);

migrateTableIfNeeded('expert_assessments', 'UNIQUE(work_id, expert_id)', `
    CREATE TABLE expert_assessments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id INTEGER NOT NULL,
        expert_id INTEGER NOT NULL,
        contestant_name TEXT NOT NULL,
        criteria_1 TEXT NOT NULL,
        criteria_2 TEXT NOT NULL,
        criteria_3 TEXT NOT NULL,
        criteria_4 TEXT NOT NULL,
        criteria_5 TEXT NOT NULL,
        criteria_6 TEXT NOT NULL,
        criteria_7 TEXT NOT NULL,
        criteria_8 TEXT NOT NULL,
        criteria_9 TEXT NOT NULL,
        criteria_10 TEXT NOT NULL,
        criteria_11 TEXT NOT NULL,
        resultativity INTEGER DEFAULT 0,
        operationality INTEGER DEFAULT 0,
        resource_intensity INTEGER DEFAULT 0,
        general_conclusion TEXT NOT NULL,
        commission_member TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(work_id, expert_id),
        FOREIGN KEY (work_id) REFERENCES works(id),
        FOREIGN KEY (expert_id) REFERENCES users(id)
    )
`);

module.exports = db;