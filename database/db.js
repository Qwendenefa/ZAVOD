// db.js — слой доступа к SQLite через пакет sql.js (SQLite, скомпилированный в WebAssembly).
// Никаких нативных бинарников: работает одинаково на любой версии Node.js и любой ОС,
// поэтому не зависит ни от glibc сервера, ни от версии Node, которую реально использует хостинг.
//
// Особенность: sql.js держит базу целиком в памяти. Чтобы данные не терялись, после каждой
// операции записи (INSERT/UPDATE/DELETE) база целиком сохраняется на диск через persistDb().
// Для этого приложения (учебный проект с невысокой нагрузкой) это абсолютно нормально.
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// В Amvera только папка /data (постоянное хранилище) переживает перезапуск/пересборку контейнера.
// Локально (там, где /data нет) база сохраняется рядом с проектом — для удобства разработки.
const PERSIST_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data');
fs.mkdirSync(PERSIST_DIR, { recursive: true });
const DB_PATH = path.join(PERSIST_DIR, 'db.sqlite');

function persistDb(db) {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// dbReady — промис, который резолвится готовой к работе базой данных.
// Инициализация WebAssembly-модуля асинхронна, поэтому весь модуль db.js отдаёт промис,
// а не сам объект базы (в app.js все обращения к базе дожидаются этого промиса).
const dbReady = (async () => {
    const SQL = await initSqlJs();

    let db;
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
        console.log('База данных загружена из', DB_PATH);
    } else {
        db = new SQL.Database();
        console.log('Создана новая база данных в', DB_PATH);
    }

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
    console.log('Таблица users готова');

    db.run(`
        CREATE TABLE IF NOT EXISTS works (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            type TEXT NOT NULL,
            file_path TEXT NOT NULL,
            original_name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'pending',          -- новый статус
            assigned_expert_id INTEGER,             -- ID эксперта, назначенного на работу
            rating INTEGER,                         -- оценка эксперта
            review_comment TEXT,                    -- текст рецензии
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (assigned_expert_id) REFERENCES users(id)
        )
    `);
    console.log('Таблица works готова');

    // Проверяем наличие колонок в works и добавляем недостающие (для обратной совместимости)
    try {
        const tableInfo = db.exec("PRAGMA table_info(works)");
        if (tableInfo.length > 0) {
            const columns = tableInfo[0].values.map(row => row[1]); // имена колонок
            if (!columns.includes('status')) {
                db.run("ALTER TABLE works ADD COLUMN status TEXT DEFAULT 'pending'");
                console.log('Добавлена колонка status в works');
            }
            if (!columns.includes('assigned_expert_id')) {
                db.run("ALTER TABLE works ADD COLUMN assigned_expert_id INTEGER REFERENCES users(id)");
                console.log('Добавлена колонка assigned_expert_id в works');
            }
            if (!columns.includes('rating')) {
                db.run("ALTER TABLE works ADD COLUMN rating INTEGER");
                console.log('Добавлена колонка rating в works');
            }
            if (!columns.includes('review_comment')) {
                db.run("ALTER TABLE works ADD COLUMN review_comment TEXT");
                console.log('Добавлена колонка review_comment в works');
            }
        }
    } catch (err) {
        console.warn('Ошибка при добавлении колонок в works (возможно, они уже есть):', err.message);
    }

    // Индексы для ускорения запросов
    db.run("CREATE INDEX IF NOT EXISTS idx_works_status ON works(status)");
    db.run("CREATE INDEX IF NOT EXISTS idx_works_assigned_expert ON works(assigned_expert_id)");

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
    `);
    console.log('Таблица reviews готова');

    // Таблица для конкурсных работ (форма expert-assessment.html)
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
    `);
    console.log('Таблица expert_assessments готова');

    persistDb(db);
    console.log('База данных готова (sql.js)');

    return db;
})();

module.exports = { dbReady, persistDb, DB_PATH };