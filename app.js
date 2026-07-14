// Подключаем библиотеки
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const iconv = require('iconv-lite');

const db = require('./database/db');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '/frontend')));

// Секрет для JWT (в реальном проекте вынести в .env)
// В проде задайте JWT_SECRET через «Переменные и секреты» в Amvera — не храните секрет в коде.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// ----- МЕТОДЫ БД -----
// db.js отдаёт объект node:sqlite DatabaseSync — методы синхронные, но здесь
// оборачиваем их в Promise, чтобы весь остальной код (написанный под async/await) не менялся.
const dbGet = (sql, params = []) => Promise.resolve(db.prepare(sql).get(...params));
const dbAll = (sql, params = []) => Promise.resolve(db.prepare(sql).all(...params));
const dbRun = (sql, params = []) => {
  const info = db.prepare(sql).run(...params);
  return Promise.resolve({ lastID: Number(info.lastInsertRowid), changes: Number(info.changes) });
};

// Оборачивает async-обработчик, чтобы ошибки уходили в централизованный middleware
const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ----- СЛУЖЕБНЫЕ МАРШРУТЫ -----
app.get('/', (req, res) => res.json({ message: 'Привет! Сервер работает!' }));

app.get('/info', (req, res) => res.json({
    name: 'Мой Express.js сервер',
    version: '0.0.1',
    status: 'работает'
}));

app.get('/hello/:name', (req, res) => res.json({ message: `Привет, ${req.params.name}!` }));

app.get('/time', (req, res) => {
    const now = new Date();
    res.json({
        currentTime: now.toISOString(),
        date: now.toLocaleDateString('ru-RU'),
        time: now.toLocaleTimeString('ru-RU')
    });
});

// ----- MIDDLEWARE АУТЕНТИФИКАЦИИ -----
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

// ----- РЕГИСТРАЦИЯ И ЛОГИН -----
app.post('/auth/register', asyncHandler(async (req, res) => {
    const { email, password, login } = req.body;
    const passwordRepeat = req.body.passwordRepeat || req.body['repeat-password'];

    if (!email || !password || !passwordRepeat || !login) {
        return res.status(400).send('Все поля обязательны');
    }
    if (password !== passwordRepeat) {
        return res.status(400).send('Пароли не совпадают');
    }
    if (password.length < 6) {
        return res.status(400).send('Пароль должен быть не менее 6 символов');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedLogin = login.trim();

    const [emailTaken, loginTaken] = await Promise.all([
        dbGet('SELECT id FROM users WHERE email = ?', [normalizedEmail]),
        dbGet('SELECT id FROM users WHERE login = ?', [normalizedLogin])
    ]);
    if (emailTaken) return res.status(409).send('Email уже зарегистрирован');
    if (loginTaken) return res.status(409).send('Логин уже занят');

    const passwordHash = bcrypt.hashSync(password, 10);
    const { lastID } = await dbRun(
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

    const user = await dbGet(
        'SELECT id, email, login, password_hash, role FROM users WHERE email = ? OR login = ?',
        [login, login]
    );

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Неверный логин/email или пароль' });
    }

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, login: user.login, role: user.role } });
}));

// ----- ПРОФИЛЬ -----
app.get('/me', authenticate, asyncHandler(async (req, res) => {
    const user = await dbGet(
        'SELECT id, email, login, role, created_at FROM users WHERE id = ?',
        [req.userId]
    );
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(user);
}));

// ----- ЗАГРУЗКА ФАЙЛОВ (multer) -----
const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx'];
// В Amvera постоянное хранилище примонтировано в /data (см. amvera.yml -> run.persistenceMount).
// Файлы, сохранённые не в /data, будут потеряны при каждом перезапуске/пересборке контейнера.
// Локально (когда /data не существует) используем папку рядом с проектом — для разработки.
const PERSIST_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
fs.mkdirSync(PERSIST_DIR, { recursive: true });

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
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        const isAllowed = ALLOWED_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase());
        cb(isAllowed ? null : new Error('Разрешены только PDF, DOC, DOCX'), isAllowed);
    }
});

// Загрузка новой работы
app.post('/api/works', authenticate, upload.single('file'), asyncHandler(async (req, res) => {
    const { title, type } = req.body;
    const file = req.file;

    if (!title || !type || !file) {
        return res.status(400).json({ error: 'Все поля обязательны' });
    }

    // Перекодируем имя файла из Windows-1251 в UTF-8
    const originalName = iconv.decode(Buffer.from(file.originalname, 'binary'), 'win1251');

    const { lastID } = await dbRun(
        `INSERT INTO works (user_id, title, type, file_path, original_name) VALUES (?, ?, ?, ?, ?)`,
        [req.userId, title, type, file.path, originalName]
    );

    res.status(201).json({ id: lastID, title, type, file_path: file.path, original_name: originalName });
}));

// Скачивание файла по ID работы
app.get('/api/works/:id/file', authenticate, asyncHandler(async (req, res) => {
    const row = await dbGet('SELECT file_path, original_name FROM works WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Файл не найден' });
    if (!fs.existsSync(row.file_path)) return res.status(404).json({ error: 'Файл отсутствует на сервере' });
    res.download(row.file_path, row.original_name);
}));

// Список работ текущего пользователя
app.get('/api/works', authenticate, asyncHandler(async (req, res) => {
    const rows = await dbAll(
        'SELECT id, title, type, original_name, created_at FROM works WHERE user_id = ? ORDER BY created_at DESC',
        [req.userId]
    );
    res.json(rows);
}));

// Список всех работ (для авторизованных пользователей)
// Для каждой работы дополнительно указываем, оценил ли её уже текущий пользователь —
// фронтенд использует это, чтобы показать либо кнопку "Оценить", либо "Посмотреть результаты".
app.get('/api/works/all', authenticate, asyncHandler(async (req, res) => {
    const rows = await dbAll(`
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

// Работы, доступные текущему пользователю для оценки:
// не свои и ещё не оценённые им работы.
app.get('/api/works/available', authenticate, asyncHandler(async (req, res) => {
    const rows = await dbAll(`
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

// Базовая информация об одной работе (используется формами оценки для заголовка и проверки типа)
app.get('/api/works/:id', authenticate, asyncHandler(async (req, res) => {
    const work = await dbGet(
        'SELECT id, title, type, original_name, user_id, created_at FROM works WHERE id = ?',
        [req.params.id]
    );
    if (!work) return res.status(404).json({ error: 'Работа не найдена' });
    res.json(work);
}));

// Статус оценки конкретной работы текущим пользователем
app.get('/api/works/:id/evaluation-status', authenticate, asyncHandler(async (req, res) => {
    const work = await dbGet('SELECT id, type, user_id FROM works WHERE id = ?', [req.params.id]);
    if (!work) return res.status(404).json({ error: 'Работа не найдена' });

    const table = work.type === 'article' ? 'reviews' : 'expert_assessments';
    const idColumn = work.type === 'article' ? 'work_id' : 'work_id';
    const existing = await dbGet(
        `SELECT id FROM ${table} WHERE ${idColumn} = ? AND expert_id = ?`,
        [work.id, req.userId]
    );

    res.json({
        workId: work.id,
        type: work.type,
        isOwnWork: work.user_id === req.userId,
        alreadyEvaluated: !!existing
    });
}));

// Сохранение рецензии на научную статью (форма form.html)
app.post('/api/reviews', authenticate, asyncHandler(async (req, res) => {
    const {
        work_id, profile_match, article_type,
        quality_1, quality_2, quality_3, quality_4, quality_5,
        quality_6, quality_7, quality_8, quality_9,
        eval_1, eval_2, eval_3,
        publication_decision, justification
    } = req.body;

    if (!work_id) return res.status(400).json({ error: 'Не указана работа (work_id)' });

    const work = await dbGet('SELECT id, type, user_id FROM works WHERE id = ?', [work_id]);
    if (!work) return res.status(404).json({ error: 'Работа не найдена' });
    if (work.type !== 'article') return res.status(400).json({ error: 'Эта форма предназначена только для научных статей' });
    if (work.user_id === req.userId) return res.status(403).json({ error: 'Нельзя оценивать собственную работу' });

    const requiredFields = {
        profile_match, article_type, eval_1, eval_2, eval_3, publication_decision
    };
    for (const [key, value] of Object.entries(requiredFields)) {
        if (value === undefined || value === null || value === '') {
            return res.status(400).json({ error: `Поле "${key}" обязательно для заполнения` });
        }
    }

    try {
        const { lastID } = await dbRun(
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

// Сохранение экспертного листа по конкурсной работе (форма expert-assessment.html)
app.post('/api/expert-assessment', authenticate, asyncHandler(async (req, res) => {
    const {
        work_id, contestant_name,
        criteria_1, criteria_2, criteria_3, criteria_4, criteria_5,
        criteria_6, criteria_7, criteria_8, criteria_9, criteria_10, criteria_11,
        resultativity, operationality, resource_intensity,
        general_conclusion, commission_member
    } = req.body;

    if (!work_id) return res.status(400).json({ error: 'Не указана работа (work_id)' });

    const work = await dbGet('SELECT id, type, user_id FROM works WHERE id = ?', [work_id]);
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
        const { lastID } = await dbRun(
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

// Результаты оценки работы с базовым анализом.
// Доступно автору работы и всем, кто уже оставил по ней оценку.
app.get('/api/works/:id/results', authenticate, asyncHandler(async (req, res) => {
    const work = await dbGet(
        'SELECT w.id, w.title, w.type, w.original_name, w.user_id, u.login AS author FROM works w JOIN users u ON w.user_id = u.id WHERE w.id = ?',
        [req.params.id]
    );
    if (!work) return res.status(404).json({ error: 'Работа не найдена' });

    if (work.type === 'article') {
        const rows = await dbAll(`
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
        const rows = await dbAll(`
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

// ----- ДЛЯ ОТЛАДКИ (можно удалить) -----
app.get('/debug/users', asyncHandler(async (req, res) => {
    const rows = await dbAll('SELECT id, email, login, role, created_at FROM users');
    res.json(rows);
}));

// ----- ЗАПУСК СЕРВЕРА -----
// Amvera прокидывает трафик на порт, указанный в amvera.yml -> run.containerPort.
// Он должен совпадать с тем портом, который слушает приложение — используем переменную окружения PORT,
// которую Amvera передаёт автоматически, с запасным значением для локальной разработки.
const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`Сервер запущен и работает на порту ${PORT}`));

// ----- ЗАКРЫТИЕ БАЗЫ ПРИ ОСТАНОВКЕ -----
function shutdown() {
    console.log('Останавливаем сервер... ⛔');
    try {
        db.close();
        console.log('База закрыта. До встречи! 👋');
        process.exit(0);
    } catch (err) {
        console.error('Не получилось закрыть базу:', err.message);
        process.exit(1);
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ----- ЦЕНТРАЛИЗОВАННЫЙ ОБРАБОТЧИК ОШИБОК (в конце) -----
app.use((err, req, res, next) => {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Упс! Что-то пошло не так. Попробуй ещё раз.' });
});
