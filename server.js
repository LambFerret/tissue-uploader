import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { ZipArchive } from 'archiver';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { moveFile, removeFile } from './lib/files.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const imageConcurrency = Math.min(2, Math.max(1, Number(process.env.IMAGE_CONCURRENCY) || 1));
sharp.concurrency(imageConcurrency);
sharp.cache({ memory: Math.min(64, Math.max(0, Number(process.env.SHARP_CACHE_MB) || 32)), files: 0, items: 50 });

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
for (const dir of ['', 'originals', 'thumbs', 'tmp']) mkdirSync(path.join(data, dir), { recursive: true });
const passwordFile = path.join(data, 'admin-password.txt');
if (!process.env.ADMIN_PASSWORD && !existsSync(passwordFile)) writeFileSync(passwordFile, randomBytes(18).toString('base64url'), { mode: 0o600 });
const password = process.env.ADMIN_PASSWORD || readFileSync(passwordFile, 'utf8').trim();
const db = new DatabaseSync(path.join(data, 'photos.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS photos (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, nickname TEXT NOT NULL, name TEXT NOT NULL,
 size INTEGER NOT NULL, created TEXT NOT NULL, format TEXT NOT NULL, request_id TEXT UNIQUE);
 CREATE INDEX IF NOT EXISTS photos_created ON photos(created);
 CREATE INDEX IF NOT EXISTS photos_owner_created ON photos(owner,created,id);
 CREATE INDEX IF NOT EXISTS photos_created_id ON photos(created,id);
 CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);`);
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use(helmet({ referrerPolicy: { policy: 'same-origin' }, contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'blob:', 'data:'], 'script-src': ["'self'"], 'upgrade-insecure-requests': null } } }));
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use('/api', (req, res, next) => {
 res.set('Cache-Control', 'no-store');
 if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')) return res.status(403).json({ error: '허용되지 않은 요청입니다.' });
 next();
});
const hash = value => createHash('sha256').update(value).digest('hex');
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')));
function admin(req, res, next) {
 const session = db.prepare('SELECT expires FROM sessions WHERE token=?').get(hash(cookie(req).admin || ''));
 if (!session || session.expires < Date.now()) return res.status(401).json({ error: '관리자 로그인이 필요합니다.' });
 next();
}
app.get('/api/config', async (req, res) => {
 const url = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '') + '/';
 const uploadConcurrency = Math.min(3, Math.max(1, Number(process.env.UPLOAD_CONCURRENCY) || 3));
 res.json({ url, qr: await QRCode.toDataURL(url, { width: 360, margin: 2 }), maxMB: 30, uploadConcurrency });
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.post('/api/admin/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false, message: { error: '잠시 후 다시 시도해 주세요.' } }), (req, res) => {
 if (typeof req.body.password !== 'string' || !timingSafeEqual(Buffer.from(hash(req.body.password)), Buffer.from(hash(password)))) return res.status(401).json({ error: '비밀번호를 확인해 주세요.' });
 const token = randomBytes(32).toString('hex');
 db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
 db.prepare('INSERT INTO sessions VALUES (?,?)').run(hash(token), Date.now() + 86400000);
 res.cookie('admin', token, { httpOnly: true, sameSite: 'strict', secure: req.secure || process.env.PUBLIC_URL?.startsWith('https:'), maxAge: 86400000 });
 res.json({ ok: true });
});
app.get('/api/admin/session', admin, (req, res) => res.json({ ok: true }));
app.post('/api/admin/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE token=?').run(hash(cookie(req).admin || '')); res.clearCookie('admin'); res.json({ ok: true }); });
function owner(req, res, next) {
 const value = req.get('X-Visitor-Id');
 if (!/^[a-f0-9-]{36}$/.test(value || '')) return res.status(400).json({ error: '이용자 정보를 새로고침해 주세요.' });
 req.owner = hash(value); next();
}
const upload = multer({ dest: path.join(data, 'tmp'), limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 4 } });
app.post('/api/photos', owner, upload.single('photo'), async (req, res, next) => {
 const file = req.file;
 let original, thumb;
 try {
  const nickname = String(req.body.institution || req.body.nickname || '').trim();
  if (!file || !nickname || nickname.length > 100) return res.status(400).json({ error: '사진과 1~100자의 의료기관명을 입력해주세요.' });
  const requestId = String(req.body.requestId || '');
  if (!/^[a-f0-9-]{36}$/.test(requestId)) return res.status(400).json({ error: '업로드 요청 정보가 잘못되었습니다.' });
  const previous = db.prepare('SELECT * FROM photos WHERE request_id=? AND owner=?').get(requestId, req.owner);
  if (previous) return res.json(previous);
  // Decode bytes, not the path: libvips' file cache can lock the input on Windows.
  const input = await readFile(file.path);
  let metadata;
  try { metadata = await sharp(input, { limitInputPixels: 100000000 }).metadata(); } catch { return res.status(415).json({ error: '읽을 수 없는 사진입니다. JPG, PNG, WebP, GIF 또는 AVIF로 올려 주세요.' }); }
  if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'heif'].includes(metadata.format)) return res.status(415).json({ error: '지원하지 않는 사진 형식입니다.' });
  const id = randomUUID(); thumb = path.join(data, 'thumbs', id + '.jpg'); original = path.join(data, 'originals', id);
  try {
   await sharp(input, { limitInputPixels: 100000000 }).rotate().resize(900, 900, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(thumb);
  } catch (error) { error.code ||= 'IMAGE_DECODE_FAILED'; throw error; }
  await moveFile(file.path, original);
  const photo = { id, owner: req.owner, nickname, name: String(req.body.name || file.originalname).replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200), size: file.size, created: new Date().toISOString(), format: metadata.format, request_id: requestId };
  db.prepare('INSERT INTO photos VALUES (@id,@owner,@nickname,@name,@size,@created,@format,@request_id)').run(photo);
  res.status(201).json(photo);
 } catch (error) { if (original) await removeFile(original); if (thumb) await removeFile(thumb); next(error); }
 finally { if (file) await removeFile(file.path); }
});
const pageSize = 60;
function photoFilter(query, ownerId) {
 const conditions = [], args = [];
 if (ownerId) { conditions.push('owner=?'); args.push(ownerId); }
 const institution = query.institution || query.nickname;
 if (institution) { conditions.push('instr(lower(nickname),lower(?)) > 0'); args.push(String(institution)); }
 for (const [value, end] of [[query.from || query.date, false], [query.to || query.date, true]]) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
   const boundary = new Date(`${value}T00:00:00+09:00`);
   if (Number.isFinite(boundary.getTime())) { conditions.push(end ? 'created < ?' : 'created >= ?'); args.push(new Date(boundary.getTime() + (end ? 86400000 : 0)).toISOString()); }
  }
 }
 const orders = { newest:'created DESC, id DESC', oldest:'created ASC, id ASC', institution:'nickname COLLATE NOCASE ASC, created DESC, id DESC', 'institution-desc':'nickname COLLATE NOCASE DESC, created DESC, id DESC' };
 return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', args, order: orders[query.sort] || orders.newest };
}
function queryPhotos(query) {
 const { where, args, order } = photoFilter(query);
 return db.prepare(`SELECT id,nickname,name,size,created FROM photos ${where} ORDER BY ${order}`).all(...args);
}
function photoPage(query, ownerId) {
 const { where, args, order } = photoFilter(query, ownerId);
 const stats = db.prepare(`SELECT count(*) AS total, count(DISTINCT nickname) AS institutions, coalesce(sum(size),0) AS bytes FROM photos ${where}`).get(...args);
 const pages = Math.max(1,Math.ceil(stats.total/pageSize));
 const page = Math.min(pages,Math.max(1,Math.floor(Number(query.page)||1)));
 const photos = db.prepare(`SELECT id,nickname,name,size,created FROM photos ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args,pageSize,(page-1)*pageSize);
 return { photos, ...stats, page, pages, pageSize };
}
app.get('/api/photos/mine', owner, (req, res) => res.json(photoPage(req.query, req.owner)));
app.get('/api/admin/photos', admin, (req, res) => {
 const overall = db.prepare('SELECT count(*) AS total, count(DISTINCT nickname) AS institutions, coalesce(sum(size),0) AS bytes FROM photos').get();
 res.json({ ...photoPage(req.query), overall });
});
app.all('/api/admin/download', admin, (req, res) => {
 if (!['GET', 'POST'].includes(req.method)) return res.sendStatus(405);
 const filters = req.method === 'POST' ? req.body : req.query;
 const selected = new Set(String(filters.ids || '').split(',').filter(Boolean));
 const photos = queryPhotos(filters).filter(p => !selected.size || selected.has(p.id));
 if (!photos.length) return res.status(404).json({ error: '다운로드할 사진이 없습니다.' });
 res.attachment('moa-photos.zip');
 const archive = new ZipArchive({ zlib: { level: 0 } });
 archive.on('error', error => res.destroy(error));
 archive.on('warning', error => res.destroy(error));
 res.on('close', () => archive.abort()); archive.pipe(res);
 for (const p of photos) archive.file(path.join(data, 'originals', p.id), { name: `${p.nickname.replace(/[^\p{L}\p{N}_-]/gu, '_')}/${p.created.slice(0, 10)}_${p.id.slice(0, 8)}_${p.name}` });
 archive.finalize().catch(error => res.destroy(error));
});
app.get('/api/photos/:id/:kind', (req, res, next) => {
 const photo = db.prepare('SELECT * FROM photos WHERE id=?').get(req.params.id);
 if (!photo) return res.sendStatus(404);
 const send = () => req.params.kind === 'original' ? res.download(path.join(data, 'originals', photo.id), photo.name) : res.sendFile(path.join(data, 'thumbs', photo.id + '.jpg'));
 if (hash(req.get('X-Visitor-Id') || '') === photo.owner) return send();
 admin(req, res, send);
});
app.use(express.static(path.join(root, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(root, 'public/index.html')));
app.use((error, req, res, next) => {
 const reference = randomUUID().slice(0,8);
 console.error(`[${reference}]`, error.code || error.name, error.message);
 const failures = {
  LIMIT_FILE_SIZE: [400, '사진 한 장은 30MB까지 업로드할 수 있습니다.'],
  EBUSY: [503, '서버 파일이 잠겨 저장하지 못했습니다. 재시도를 눌러주세요.'],
  EPERM: [503, '서버 파일에 접근하지 못했습니다. 재시도를 눌러주세요.'],
  EACCES: [503, '서버 저장 폴더의 접근 권한을 확인해주세요.'],
  ENOSPC: [507, '서버 저장 공간이 부족합니다. 관리자에게 문의해주세요.'],
  IMAGE_DECODE_FAILED: [415, '사진 데이터를 읽지 못했습니다. JPG로 다시 저장한 뒤 업로드해주세요.']
 };
 const [status, message] = failures[error.code] || [error instanceof multer.MulterError ? 400 : 500, '서버 저장 오류입니다. 재시도하거나 오류 번호를 관리자에게 전달해주세요.'];
 res.status(status).json({ error: `${message} (${reference})`, code: error.code || 'SERVER_ERROR', reference });
});
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
 console.log(`Tissue uploader ready: http://localhost:${process.env.PORT || 3000}`);
 if (!process.env.ADMIN_PASSWORD) console.log(`Admin password file: ${passwordFile}`);
});
function shutdown() {
 server.close(() => { db.close(); process.exit(0); });
 setTimeout(() => process.exit(1), 30000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
