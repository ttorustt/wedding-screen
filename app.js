const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Redis } = require('@upstash/redis');
const { put, del } = require('@vercel/blob');

const app = express();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'wedding2026';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'state.json');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const REDIS_KEY = 'wedding-screen:state:v3';
const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
const redis = hasRedis ? Redis.fromEnv() : null;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const defaultState = { background: '', activeMessageId: null, messages: [] };
function cloneDefault(){ return JSON.parse(JSON.stringify(defaultState)); }
async function loadState(){
  if (redis) {
    const data = await redis.get(REDIS_KEY);
    return data ? { ...cloneDefault(), ...data } : cloneDefault();
  }
  try { return { ...cloneDefault(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch { return cloneDefault(); }
}
async function saveState(state){
  if (redis) return redis.set(REDIS_KEY, state);
  fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
}
function activeMessage(state){ return state.messages.find(m => m.id === state.activeMessageId) || null; }
function publicState(state){ return { background: state.background, activeMessage: activeMessage(state), updatedAt: Date.now() }; }
function adminOk(req){ return req.headers['x-admin-password'] === ADMIN_PASSWORD; }
function setPreviousShown(state){ const p = activeMessage(state); if (p) p.status = 'shown'; }

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_, file, cb) => /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)
    ? cb(null, true)
    : cb(new Error('Разрешены JPG, PNG, WEBP или GIF'))
});

app.get('/', (_, res) => res.redirect('/guest'));
for (const p of ['guest', 'admin', 'screen']) {
  app.get('/' + p, (_, res) => res.sendFile(path.join(PUBLIC_DIR, p + '.html')));
}

app.get('/api/health', async (_, res) => {
  res.json({ ok: true, storage: hasRedis ? 'upstash' : 'local-file', uploads: hasBlob ? 'vercel-blob' : 'local-file' });
});

app.get('/api/public-state', async (_, res) => {
  try { res.json(publicState(await loadState())); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Не удалось получить состояние экрана' }); }
});

const recentPosts = new Map();
app.post('/api/messages', async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Напиши сообщение' });
    if (text.length > 500) return res.status(400).json({ error: 'Максимум 500 символов' });
    const key = req.ip || 'unknown', now = Date.now(), last = recentPosts.get(key) || 0;
    if (now - last < 2500) return res.status(429).json({ error: 'Слишком быстро. Попробуй ещё раз через пару секунд.' });
    recentPosts.set(key, now);
    const state = await loadState();
    const msg = { id: crypto.randomUUID(), text, createdAt: new Date().toISOString(), shownAt: null, status: 'new' };
    state.messages.unshift(msg);
    await saveState(state);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Не удалось отправить сообщение' }); }
});

app.post('/api/admin/login', (req, res) => String(req.body.password || '') === ADMIN_PASSWORD
  ? res.json({ ok: true })
  : res.status(401).json({ error: 'Неверный пароль' }));

app.get('/api/admin/messages', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const state = await loadState();
    res.json({ messages: state.messages, ...publicState(state) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Не удалось загрузить сообщения' }); }
});

app.get('/api/qr', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${proto}://${req.get('host')}/guest`;
  res.type('svg');
  QRCode.toString(url, { type: 'svg', margin: 1, width: 600, errorCorrectionLevel: 'M' }, (err, svg) =>
    err ? res.status(500).send('QR error') : res.send(svg));
});

app.post('/api/admin/background', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  upload.single('background')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Выбери изображение' });
    try {
      const state = await loadState();
      const old = state.background;
      if (hasBlob) {
        const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
        const blob = await put(`wedding-screen/background-${Date.now()}${ext}`, req.file.buffer, {
          access: 'public',
          contentType: req.file.mimetype,
          addRandomSuffix: true
        });
        state.background = blob.url;
        if (old && old.includes('.public.blob.vercel-storage.com')) del(old).catch(() => {});
      } else {
        const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
        const filename = `bg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);
        state.background = `/uploads/${filename}`;
        if (old && old.startsWith('/uploads/')) fs.unlink(path.join(PUBLIC_DIR, old), () => {});
      }
      await saveState(state);
      res.json({ ok: true, background: state.background });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Не удалось сохранить заставку' }); }
  });
});

async function showById(id, res){
  try {
    const state = await loadState();
    const msg = state.messages.find(m => m.id === id);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (state.activeMessageId !== msg.id) setPreviousShown(state);
    state.activeMessageId = msg.id;
    msg.status = 'active';
    msg.shownAt = new Date().toISOString();
    await saveState(state);
    res.json({ ok: true, message: msg });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Не удалось показать сообщение' }); }
}

app.post('/api/admin/show/:id', (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  showById(req.params.id, res);
});

app.post('/api/admin/next', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const state = await loadState();
    const candidate = [...state.messages].reverse().find(m => m.status === 'new');
    if (!candidate) return res.status(404).json({ error: 'Новых сообщений нет' });
    showById(candidate.id, res);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Не удалось показать следующее сообщение' }); }
});

app.post('/api/admin/hide', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const state = await loadState();
    setPreviousShown(state);
    state.activeMessageId = null;
    await saveState(state);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Не удалось убрать сообщение' }); }
});

app.delete('/api/admin/messages/:id', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const state = await loadState();
    const wasActive = state.activeMessageId === req.params.id;
    state.messages = state.messages.filter(m => m.id !== req.params.id);
    if (wasActive) state.activeMessageId = null;
    await saveState(state);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Не удалось удалить сообщение' }); }
});

app.post('/api/admin/clear-shown', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const state = await loadState();
    state.messages = state.messages.filter(m => m.status !== 'shown');
    await saveState(state);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Не удалось очистить сообщения' }); }
});

module.exports = app;
