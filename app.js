// Подключаем библиотеки
const express = require('express');
const path = require('path');
const fs = require('fs');

console.log('✅ app.js существует:', fs.existsSync(__filename));
console.log('✅ Папка frontend существует:', fs.existsSync(path.join(__dirname, 'frontend')));
console.log('✅ Папка database существует:', fs.existsSync(path.join(__dirname, 'database')));
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const iconv = require('iconv-lite');

const Database = require('better-sqlite3');

const app = express();

// ---- Настройка БД ----
const PERSIST_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
fs.mkdirSync(PERSIST_DIR, { recursive: true });
const DB_PATH = path.join(PERSIST_DIR, 'db.sqlite');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('encoding = "UTF-8"');

// ---- Принудительная миграция для добавления колонок в works ----
function ensureWorksColumns() {
    const tableInfo = db.prepare("PRAGMA table_info(works)").all();
    const columnNames = tableInfo.map(row => row.name);
    console.log('📋 Существующие колонки в works:', columnNames.join(', '));

    const columnsToAdd = {
        status: "TEXT DEFAULT 'pending'",
        assigned_expert_id: "INTEGER REFERENCES users(id)",
        rating: "INTEGER",
        review_comment: "TEXT"
    };

    for (const [col, definition] of Object.entries(columnsToAdd)) {
        if (!columnNames.includes(col)) {
            try {
                db.exec(`ALTER TABLE works ADD COLUMN ${col} ${definition}`);
                console.log(`✅ Добавлена колонка ${col} в works`);
            } catch (err) {
                console.error(`❌ Ошибка добавления колонки ${col}:`, err.message);
            }
        }
    }

    db.exec("CREATE INDEX IF NOT EXISTS idx_works_status ON works(status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_works_assigned_expert ON works(assigned_expert_id)");
}

// Инициализация таблиц
const initDb = () => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            login TEXT UNIQUE,
            password_hash TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            role TEXT DEFAULT 'author',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
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
    `);

    ensureWorksColumns();

    db.exec(`
        CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            work_id INTEGER NOT NULL,
            expert_id INTEGER NOT NULL,
            profile_match TEXT NOT NULL,
            article_type TEXT NOT NULL,
            quality_1 TEXT, quality_2 TEXT, quality_3 TEXT,
            quality_4 TEXT, quality_5 TEXT, quality_6 TEXT,
            quality_7 TEXT, quality_8 TEXT, quality_9 TEXT,
            eval_1 INTEGER NOT NULL, eval_2 INTEGER NOT NULL, eval_3 INTEGER NOT NULL,
            publication_decision TEXT NOT NULL,
            justification TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(work_id, expert_id),
            FOREIGN KEY (work_id) REFERENCES works(id),
            FOREIGN KEY (expert_id) REFERENCES users(id)
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS expert_assessments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            work_id INTEGER NOT NULL,
            expert_id INTEGER NOT NULL,
            contestant_name TEXT NOT NULL,
            criteria_1 TEXT NOT NULL, criteria_2 TEXT NOT NULL,
            criteria_3 TEXT NOT NULL, criteria_4 TEXT NOT NULL,
            criteria_5 TEXT NOT NULL, criteria_6 TEXT NOT NULL,
            criteria_7 TEXT NOT NULL, criteria_8 TEXT NOT NULL,
            criteria_9 TEXT NOT NULL, criteria_10 TEXT NOT NULL,
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
    console.log('✅ База данных и таблицы готовы (с миграцией works)');
};
initDb();

// ---- Обёртки для БД ----
const dbGet = (sql, params = []) => db.prepare(sql).get(...params);
const dbAll = (sql, params = []) => db.prepare(sql).all(...params);
const dbRun = (sql, params = []) => {
    const info = db.prepare(sql).run(...params);
    return { lastID: Number(info.lastInsertRowid), changes: Number(info.changes) };
};

// ---- Express настройки ----
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static(path.join(__dirname, 'frontend'), {
    maxAge: '1d',
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (JWT_SECRET === 'dev-secret-change-me' && process.env.NODE_ENV === 'production') {
    console.warn('⚠️ В продакшене используйте реальный JWT_SECRET!');
}

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---- Служебные маршруты ----
app.get('/', (req, res) => res.json({ message: 'Привет! Сервер работает!' }));
app.get('/info', (req, res) => res.json({ name: 'Мой Express.js сервер', version: '0.0.1', status: 'работает' }));
app.get('/hello/:name', (req, res) => res.json({ message: `Привет, ${req.params.name}!` }));
app.get('/time', (req, res) => {
    const now = new Date();
    res.json({ currentTime: now.toISOString(), date: now.toLocaleDateString('ru-RU'), time: now.toLocaleTimeString('ru-RU') });
});

// ---- Middleware аутентификации ----
function authenticate(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    if (!token) return res.status(401).json({ error: 'Нужен токен авторизации' });
    jwt.verify(token, JWT_SECRET, (err, payload) => {
        if (err) return res.status(401).json({ error: 'Токен недействителен или истёк' });
        req.userId = payload.userId;
        req.userRole = payload.role;
        next();
    });
}

// ---- Регистрация и логин ----
app.post('/auth/register', asyncHandler(async (req, res) => {
    const { email, password, login } = req.body;
    const passwordRepeat = req.body.passwordRepeat || req.body['repeat-password'];

    if (!email || !password || !passwordRepeat || !login) {
        return res.status(400).send('Все поля обязательны');
    }
    if (password !== passwordRepeat) return res.status(400).send('Пароли не совпадают');
    if (password.length < 6) return res.status(400).send('Пароль должен быть не менее 6 символов');

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedLogin = login.trim();

    const emailTaken = dbGet('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (emailTaken) return res.status(409).send('Email уже зарегистрирован');

    const loginTaken = dbGet('SELECT id FROM users WHERE login = ?', [normalizedLogin]);
    if (loginTaken) return res.status(409).send('Логин уже занят');

    const passwordHash = await bcrypt.hash(password, 10);

    const { lastID } = dbRun(
        'INSERT INTO users (email, password_hash, login) VALUES (?, ?, ?)',
        [normalizedEmail, passwordHash, normalizedLogin]
    );

    console.log('✅ Пользователь создан, ID:', lastID);
    res.redirect('/login.html');
}));

app.post('/auth/login', asyncHandler(async (req, res) => {
    const login = (req.body?.login || '').trim();
    const password = (req.body?.password || '').trim();

    if (!login || !password) {
        return res.status(400).json({ error: 'Укажи логин/email и пароль' });
    }

    const user = dbGet(
        'SELECT id, email, login, password_hash, role FROM users WHERE email = ? OR login = ?',
        [login, login]
    );

    if (!user) return res.status(401).json({ error: 'Неверный логин/email или пароль' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Неверный логин/email или пароль' });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, login: user.login, role: user.role } });
}));

// ---- Профиль ----
app.get('/me', authenticate, asyncHandler(async (req, res) => {
    const user = dbGet(
        'SELECT id, email, login, role, created_at FROM users WHERE id = ?',
        [req.userId]
    );
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(user);
}));

// ---- Загрузка файлов ----
const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx'];
const uploadDir = path.join(PERSIST_DIR, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
            const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
            cb(null, unique + path.extname(file.originalname));
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const isAllowed = ALLOWED_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase());
        cb(isAllowed ? null : new Error('Разрешены только PDF, DOC, DOCX'), isAllowed);
    }
});

// ---- ЗАГРУЗКА РАБОТЫ (с валидацией типа) ----
const allowedTypes = ['article', 'competition'];
app.post('/api/works', authenticate, upload.single('file'), asyncHandler(async (req, res) => {
    const { title, type } = req.body;
    const file = req.file;

    if (!title || !type || !file) {
        return res.status(400).json({ error: 'Все поля обязательны' });
    }

    // Проверка допустимого типа
    if (!allowedTypes.includes(type)) {
        return res.status(400).json({ error: 'Тип работы должен быть "article" (научная статья) или "competition" (конкурсная работа)' });
    }

    const originalName = iconv.decode(Buffer.from(file.originalname, 'binary'), 'win1251');

    const { lastID } = dbRun(
        `INSERT INTO works (user_id, title, type, file_path, original_name, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.userId, title, type, file.path, originalName, 'pending']
    );

    res.status(201).json({ id: lastID, title, type, file_path: file.path, original_name: originalName });
}));

// ---- Остальные эндпоинты с работами ----
app.get('/api/works/:id/file', authenticate, asyncHandler(async (req, res) => {
    const row = dbGet('SELECT file_path, original_name FROM works WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Файл не найден' });
    if (!fs.existsSync(row.file_path)) return res.status(404).json({ error: 'Файл отсутствует на сервере' });
    res.download(row.file_path, row.original_name);
}));

app.get('/api/works', authenticate, asyncHandler(async (req, res) => {
    const rows = dbAll(
        'SELECT id, title, type, original_name, created_at FROM works WHERE user_id = ? ORDER BY created_at DESC',
        [req.userId]
    );
    res.json(rows);
}));

app.get('/api/works/all', authenticate, asyncHandler(async (req, res) => {
    const rows = dbAll(`
        SELECT w.id, w.title, w.type, w.original_name, w.created_at, w.user_id, u.login AS author,
            CASE
                WHEN w.type = 'article' THEN EXISTS(SELECT 1 FROM reviews r WHERE r.work_id = w.id AND r.expert_id = ?)
                ELSE EXISTS(SELECT 1 FROM expert_assessments ea WHERE ea.work_id = w.id AND ea.expert_id = ?)
            END AS reviewed_by_me
        FROM works w
        JOIN users u ON w.user_id = u.id
        ORDER BY w.created_at DESC
    `, [req.userId, req.userId]);
    res.json(rows.map(r => ({ ...r, reviewed_by_me: !!r.reviewed_by_me })));
}));

app.get('/api/works/available', authenticate, asyncHandler(async (req, res) => {
    const rows = dbAll(`
        SELECT w.id, w.title, w.type, w.original_name, w.created_at, u.login AS author
        FROM works w
        JOIN users u ON w.user_id = u.id
        WHERE w.user_id != ?
          AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.work_id = w.id AND r.expert_id = ?)
          AND NOT EXISTS(SELECT 1 FROM expert_assessments ea WHERE ea.work_id = w.id AND ea.expert_id = ?)
        ORDER BY w.created_at DESC
    `, [req.userId, req.userId, req.userId]);
    res.json(rows);
}));

app.get('/api/works/:id', authenticate, asyncHandler(async (req, res) => {
    const work = dbGet(
        'SELECT id, title, type, original_name, user_id, created_at FROM works WHERE id = ?',
        [req.params.id]
    );
    if (!work) return res.status(404).json({ error: 'Работа не найдена' });
    res.json(work);
}));

app.get('/api/works/:id/evaluation-status', authenticate, asyncHandler(async (req, res) => {
    const work = dbGet('SELECT id, type, user_id FROM works WHERE id = ?', [req.params.id]);
    if (!work) return res.status(404).json({ error: 'Работа не найдена' });

    const table = work.type === 'article' ? 'reviews' : 'expert_assessments';
    const existing = dbGet(
        `SELECT id FROM ${table} WHERE work_id = ? AND expert_id = ?`,
        [work.id, req.userId]
    );

    res.json({
        workId: work.id,
        type: work.type,
        isOwnWork: work.user_id === req.userId,
        alreadyEvaluated: !!existing
    });
}));

app.post('/api/reviews', authenticate, asyncHandler(async (req, res) => {
    const {
        work_id, profile_match, article_type,
        quality_1, quality_2, quality_3, quality_4, quality_5,
        quality_6, quality_7, quality_8, quality_9,
        eval_1, eval_2, eval_3,
        publication_decision, justification
    } = req.body;

    if (!work_id) return res.status(400).json({ error: 'Не указана работа (work_id)' });

    const work = dbGet('SELECT id, type, user_id FROM works WHERE id = ?', [work_id]);
    if (!work) return res.status(404).json({ error: 'Работа не найдена' });
    if (work.type !== 'article') return res.status(400).json({ error: 'Эта форма предназначена только для научных статей' });
    if (work.user_id === req.userId) return res.status(403).json({ error: 'Нельзя оценивать собственную работу' });

    const requiredFields = { profile_match, article_type, eval_1, eval_2, eval_3, publication_decision };
    for (const [key, value] of Object.entries(requiredFields)) {
        if (value === undefined || value === null || value === '') {
            return res.status(400).json({ error: `Поле "${key}" обязательно для заполнения` });
        }
    }

    try {
        const { lastID } = dbRun(
            `INSERT INTO reviews (
                work_id, expert_id, profile_match, article_type,
                quality_1, quality_2, quality_3, quality_4, quality_5,
                quality_6, quality_7, quality_8, quality_9,
                eval_1, eval_2, eval_3, publication_decision, justification
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                work_id, req.userId, profile_match, article_type,
                quality_1, quality_2, quality_3, quality_4, quality_5,
                quality_6, quality_7, quality_8, quality_9,
                Number(eval_1), Number(eval_2), Number(eval_3),
                publication_decision, justification || null
            ]
        );
        res.status(201).json({ id: lastID });
    } catch (err) {
        if (String(err.message).includes('UNIQUE')) {
            return res.status(409).json({ error: 'Вы уже оценили эту работу' });
        }
        throw err;
    }
}));

app.post('/api/expert-assessment', authenticate, asyncHandler(async (req, res) => {
    const {
        work_id, contestant_name,
        criteria_1, criteria_2, criteria_3, criteria_4, criteria_5,
        criteria_6, criteria_7, criteria_8, criteria_9, criteria_10, criteria_11,
        resultativity, operationality, resource_intensity,
        general_conclusion, commission_member
    } = req.body;

    if (!work_id) return res.status(400).json({ error: 'Не указана работа (work_id)' });

    const work = dbGet('SELECT id, type, user_id FROM works WHERE id = ?', [work_id]);
    if (!work) return res.status(404).json({ error: 'Работа не найдена' });
    if (work.type !== 'competition') return res.status(400).json({ error: 'Эта форма предназначена только для конкурсных работ' });
    if (work.user_id === req.userId) return res.status(403).json({ error: 'Нельзя оценивать собственную работу' });

    const requiredFields = {
        contestant_name,
        criteria_1, criteria_2, criteria_3, criteria_4, criteria_5,
        criteria_6, criteria_7, criteria_8, criteria_9, criteria_10, criteria_11,
        general_conclusion, commission_member
    };
    for (const [key, value] of Object.entries(requiredFields)) {
        if (value === undefined || value === null || value === '') {
            return res.status(400).json({ error: `Поле "${key}" обязательно для заполнения` });
        }
    }

    try {
        const { lastID } = dbRun(
            `INSERT INTO expert_assessments (
                work_id, expert_id, contestant_name,
                criteria_1, criteria_2, criteria_3, criteria_4, criteria_5,
                criteria_6, criteria_7, criteria_8, criteria_9, criteria_10, criteria_11,
                resultativity, operationality, resource_intensity,
                general_conclusion, commission_member
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                work_id, req.userId, contestant_name,
                criteria_1, criteria_2, criteria_3, criteria_4, criteria_5,
                criteria_6, criteria_7, criteria_8, criteria_9, criteria_10, criteria_11,
                Number(resultativity) || 0, Number(operationality) || 0, Number(resource_intensity) || 0,
                general_conclusion, commission_member
            ]
        );
        res.status(201).json({ id: lastID });
    } catch (err) {
        if (String(err.message).includes('UNIQUE')) {
            return res.status(409).json({ error: 'Вы уже оценили эту работу' });
        }
        throw err;
    }
}));

app.get('/api/works/:id/results', authenticate, asyncHandler(async (req, res) => {
    const work = dbGet(
        'SELECT w.id, w.title, w.type, w.original_name, w.user_id, u.login AS author FROM works w JOIN users u ON w.user_id = u.id WHERE w.id = ?',
        [req.params.id]
    );
    if (!work) return res.status(404).json({ error: 'Работа не найдена' });

    if (work.type === 'article') {
        const rows = dbAll(`
            SELECT r.*, u.login AS expert_login FROM reviews r
            JOIN users u ON r.expert_id = u.id
            WHERE r.work_id = ?
            ORDER BY r.created_at DESC
        `, [work.id]);

        const isAuthor = work.user_id === req.userId;
        const hasEvaluated = rows.some(r => r.expert_id === req.userId);
        if (!isAuthor && !hasEvaluated) {
            return res.status(403).json({ error: 'Результаты доступны только автору работы и экспертам, которые её оценили' });
        }

        const count = rows.length;
        const avg = (field) => count ? +(rows.reduce((s, r) => s + Number(r[field]), 0) / count).toFixed(2) : null;

        const qualityFields = ['quality_1','quality_2','quality_3','quality_4','quality_5','quality_6','quality_7','quality_8','quality_9'];
        const qualityDistribution = {};
        qualityFields.forEach(f => {
            qualityDistribution[f] = { 'нет': 0, 'низкая': 0, 'средняя': 0, 'высокая': 0 };
            rows.forEach(r => { if (qualityDistribution[f][r[f]] !== undefined) qualityDistribution[f][r[f]]++; });
        });

        const decisionDistribution = { as_is: 0, minor_revision: 0, major_revision: 0, reject: 0 };
        rows.forEach(r => { if (decisionDistribution[r.publication_decision] !== undefined) decisionDistribution[r.publication_decision]++; });

        return res.json({
            work,
            reviewsCount: count,
            averages: { eval_1: avg('eval_1'), eval_2: avg('eval_2'), eval_3: avg('eval_3') },
            qualityDistribution,
            decisionDistribution,
            reviews: rows.map(r => ({
                expert: r.expert_login,
                profile_match: r.profile_match,
                article_type: r.article_type,
                quality_1: r.quality_1, quality_2: r.quality_2, quality_3: r.quality_3,
                quality_4: r.quality_4, quality_5: r.quality_5, quality_6: r.quality_6,
                quality_7: r.quality_7, quality_8: r.quality_8, quality_9: r.quality_9,
                eval_1: r.eval_1, eval_2: r.eval_2, eval_3: r.eval_3,
                publication_decision: r.publication_decision,
                justification: r.justification,
                created_at: r.created_at
            }))
        });
    } else {
        const rows = dbAll(`
            SELECT ea.*, u.login AS expert_login FROM expert_assessments ea
            JOIN users u ON ea.expert_id = u.id
            WHERE ea.work_id = ?
            ORDER BY ea.created_at DESC
        `, [work.id]);

        const isAuthor = work.user_id === req.userId;
        const hasEvaluated = rows.some(r => r.expert_id === req.userId);
        if (!isAuthor && !hasEvaluated) {
            return res.status(403).json({ error: 'Результаты доступны только автору работы и экспертам, которые её оценили' });
        }

        const count = rows.length;
        const avg = (field) => count ? +(rows.reduce((s, r) => s + Number(r[field]), 0) / count).toFixed(2) : null;

        const criteriaFields = Array.from({length: 11}, (_, i) => `criteria_${i+1}`);
        const criteriaDistribution = {};
        criteriaFields.forEach(f => {
            criteriaDistribution[f] = { 'нет': 0, 'низкая': 0, 'средняя': 0, 'высокая': 0 };
            rows.forEach(r => { if (criteriaDistribution[f][r[f]] !== undefined) criteriaDistribution[f][r[f]]++; });
        });

        return res.json({
            work,
            reviewsCount: count,
            averages: {
                resultativity: avg('resultativity'),
                operationality: avg('operationality'),
                resource_intensity: avg('resource_intensity')
            },
            criteriaDistribution,
            reviews: rows.map(r => ({
                expert: r.expert_login,
                contestant_name: r.contestant_name,
                resultativity: r.resultativity,
                operationality: r.operationality,
                resource_intensity: r.resource_intensity,
                general_conclusion: r.general_conclusion,
                commission_member: r.commission_member,
                created_at: r.created_at
            }))
        });
    }
}));

app.get('/debug/users', asyncHandler(async (req, res) => {
    const rows = dbAll('SELECT id, email, login, role, created_at FROM users');
    res.json(rows);
}));

// ---- Смена роли ----
app.put('/auth/role', authenticate, asyncHandler(async (req, res) => {
  const { role } = req.body;
  const userId = req.userId;

  const allowedRoles = ['author', 'expert', 'admin'];
  if (!role || !allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'Недопустимая роль' });
  }

  const stmt = db.prepare('UPDATE users SET role = ? WHERE id = ?');
  const result = stmt.run(role, userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }

  const newToken = jwt.sign(
    { userId: userId, role: role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  const user = dbGet(
    'SELECT id, email, login, role, created_at FROM users WHERE id = ?',
    [userId]
  );

  res.json({
    token: newToken,
    user: user
  });
}));

// =================== АДМИН: управление работами ===================

const requireAdmin = (req, res, next) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  next();
};

const requireExpert = (req, res, next) => {
  if (req.userRole !== 'expert' && req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  next();
};

// Получить все работы (админ)
app.get('/admin/works', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const works = dbAll(`
    SELECT w.*, 
           u.login as author_name, 
           e.login as expert_name
    FROM works w
    LEFT JOIN users u ON w.user_id = u.id
    LEFT JOIN users e ON w.assigned_expert_id = e.id
    ORDER BY w.created_at DESC
  `);
  res.json(works);
}));

// НАЗНАЧИТЬ ЭКСПЕРТА (с проверкой, что эксперт не автор)
app.put('/admin/works/:id/assign', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const workId = req.params.id;
  const { expertId } = req.body;

  if (!expertId) {
    return res.status(400).json({ error: 'Не указан эксперт' });
  }

  // Получаем работу, чтобы проверить автора
  const work = dbGet('SELECT user_id FROM works WHERE id = ?', [workId]);
  if (!work) return res.status(404).json({ error: 'Работа не найдена' });

  // Проверяем, что эксперт не является автором работы
  if (work.user_id == expertId) {
    return res.status(400).json({ error: 'Нельзя назначить автора работы экспертом' });
  }

  // Проверяем, существует ли эксперт и имеет ли он роль expert
  const expert = dbGet('SELECT id, role FROM users WHERE id = ? AND role = \'expert\'', [expertId]);
  if (!expert) {
    return res.status(400).json({ error: 'Эксперт не найден или не имеет роли "expert"' });
  }

  // Обновляем работу
  const stmt = db.prepare('UPDATE works SET assigned_expert_id = ?, status = \'assigned\' WHERE id = ?');
  const result = stmt.run(expertId, workId);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Работа не найдена' });
  }

  // Возвращаем обновлённую работу
  const updated = dbGet(`
    SELECT w.*, u.login as author_name, e.login as expert_name
    FROM works w
    LEFT JOIN users u ON w.user_id = u.id
    LEFT JOIN users e ON w.assigned_expert_id = e.id
    WHERE w.id = ?
  `, [workId]);
  res.json(updated);
}));

// УДАЛИТЬ РАБОТУ (админ)
app.delete('/admin/works/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const workId = req.params.id;

  // Получаем информацию о работе (особенно путь к файлу)
  const work = dbGet('SELECT file_path FROM works WHERE id = ?', [workId]);
  if (!work) return res.status(404).json({ error: 'Работа не найдена' });

  // Удаляем файл с диска, если он существует
  if (work.file_path && fs.existsSync(work.file_path)) {
    try {
      fs.unlinkSync(work.file_path);
      console.log(`🗑️ Файл удалён: ${work.file_path}`);
    } catch (err) {
      console.error('Ошибка удаления файла:', err.message);
    }
  }

  // Удаляем связанные записи (рецензии и экспертные оценки)
  dbRun('DELETE FROM reviews WHERE work_id = ?', [workId]);
  dbRun('DELETE FROM expert_assessments WHERE work_id = ?', [workId]);

  // Удаляем саму работу
  const result = dbRun('DELETE FROM works WHERE id = ?', [workId]);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Работа не найдена' });
  }

  res.json({ message: 'Работа и все связанные данные удалены' });
}));

// =================== ЭКСПЕРТ ===================

app.get('/expert/works', authenticate, requireExpert, asyncHandler(async (req, res) => {
  const userId = req.userId;
  const works = dbAll(`
    SELECT w.*, 
           u.login as author_name
    FROM works w
    LEFT JOIN users u ON w.user_id = u.id
    WHERE w.assigned_expert_id = ? AND w.status IN ('assigned', 'reviewed')
    ORDER BY w.created_at DESC
  `, [userId]);
  res.json(works);
}));

app.put('/expert/works/:id/review', authenticate, requireExpert, asyncHandler(async (req, res) => {
  const workId = req.params.id;
  const userId = req.userId;
  const { rating, comment } = req.body;

  const work = dbGet('SELECT * FROM works WHERE id = ? AND assigned_expert_id = ? AND status = \'assigned\'', [workId, userId]);
  if (!work) {
    return res.status(403).json({ error: 'Работа не назначена вам или уже оценена' });
  }

  const stmt = db.prepare('UPDATE works SET status = \'reviewed\', rating = ?, review_comment = ? WHERE id = ?');
  const result = stmt.run(rating || null, comment || null, workId);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Работа не найдена' });
  }

  res.json({ message: 'Оценка сохранена', workId });
}));

// ---- Получение списка пользователей (с фильтром) ----
app.get('/api/users', authenticate, asyncHandler(async (req, res) => {
  const { role } = req.query;
  let sql = 'SELECT id, login, email, role FROM users';
  const params = [];
  if (role) {
    sql += ' WHERE role = ?';
    params.push(role);
  }
  sql += ' ORDER BY login';
  const users = dbAll(sql, params);
  res.json(users);
}));

// ---- Запуск сервера ----
const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порту ${PORT} (0.0.0.0)`);
    console.log(`📁 База данных: ${DB_PATH}`);
    console.log(`📂 Загрузки: ${uploadDir}`);
});

process.on('SIGINT', () => {
    console.log('⛔ Закрываем соединение с БД...');
    db.close();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('⛔ Закрываем соединение с БД...');
    db.close();
    process.exit(0);
});

app.use((err, req, res, next) => {
    console.error('❌ Ошибка:', err);
    res.status(500).json({ error: 'Упс! Что-то пошло не так. Попробуй ещё раз.' });
});