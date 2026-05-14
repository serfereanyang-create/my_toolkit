#!/usr/bin/env node
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REQUESTED_SERIAL_PORT = process.env.LABSAFE_PORT || process.argv[2] || 'COM18';
const SERIAL_BAUD = Number(process.env.LABSAFE_BAUD || process.argv[3] || 115200);
const HTTP_PORT = Number(process.env.LABSAFE_HTTP_PORT || process.argv[4] || 8765);
const TELEMETRY_PREFIX = 'LABSAFE_JSON:';
const SERIAL_RETRY_MS = 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const AUTH_DB_FILE = path.resolve(DATA_DIR, 'labsafe-auth.sqlite');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

const ROLE_PERMISSIONS = {
  '管理员': ['查看实时监控', '查看数据窗口', '确认报警事件', '调整阈值策略', '管理账号密码'],
  '操作员': ['查看实时监控', '查看数据窗口', '确认报警事件'],
  '观察员': ['查看实时监控', '查看数据窗口']
};

const DEFAULT_ACCOUNTS = [
  { username: 'labadmin', name: '实验室管理员', role: '管理员', avatar: '管', password: 'admin123' },
  { username: 'viewer', name: '安全观察员', role: '观察员', avatar: '观', password: 'viewer123' }
];

const DEFAULT_ADMIN_CONFIG = {
  dataMode: 'device',
  publishMockWhenOffline: false,
  modules: {
    overview: true,
    realDevice: true,
    sensors: true,
    vision: true,
    actuators: true,
    eventStream: true,
    trends: true,
    chartMode: true,
    deviceStatus: true,
    boardDetect: true,
    rawData: true,
    alarms: true,
    exportPanel: true
  },
  lastDistributedSnapshot: null
};

fs.mkdirSync(DATA_DIR, { recursive: true });
const authDb = new DatabaseSync(AUTH_DB_FILE);
authDb.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('管理员','操作员','观察员')),
    avatar TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const sessions = new Map();
const state = {
  bridge: 'labsafe-serial-bridge',
  port: REQUESTED_SERIAL_PORT,
  requestedPort: REQUESTED_SERIAL_PORT,
  availablePorts: [],
  baud: SERIAL_BAUD,
  upload: {
    wifiEnabled: true,
    endpoint: `http://127.0.0.1:${HTTP_PORT}/api/device/upload`,
    lastSource: null,
    lastDeviceId: null,
    lastRemoteAddress: null,
    lastUploadAt: null
  },
  connected: false,
  message: '正在启动 Windows 串口读取器',
  updatedAt: null,
  rawLine: '',
  snapshot: null
};
let serialProcess = null;
let restartTimer = null;

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, statusCode, payload) {
  setCorsHeaders(response);
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('请求体过大'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 格式错误')); }
    });
    request.on('error', reject);
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user || !user.passwordHash || !user.passwordSalt) return false;
  const expected = hashPassword(password, user.passwordSalt).hash;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

function rolePermissions(role) {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS['观察员'];
}

function mapUser(row) {
  if (!row) return null;
  return {
    username: row.username,
    name: row.name,
    role: row.role,
    avatar: row.avatar,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicAccount(user, includeHashPreview = false) {
  const account = {
    username: user.username,
    name: user.name,
    role: user.role,
    avatar: user.avatar || String(user.name || user.username || '?').slice(0, 1),
    permissions: rolePermissions(user.role),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
  if (includeHashPreview) account.passwordHashPreview = `pbkdf2:${String(user.passwordHash || '').slice(0, 10)}...`;
  return account;
}

function getUser(username) {
  return mapUser(authDb.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

function getUsers() {
  return authDb.prepare('SELECT * FROM users ORDER BY created_at ASC, username ASC').all().map(mapUser);
}

function deepMerge(base, patch) {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      output[key] = deepMerge(base[key], value);
    } else if (typeof value !== 'undefined') {
      output[key] = value;
    }
  }
  return output;
}

function getSetting(key, fallback) {
  const row = authDb.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  authDb.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString());
}

function getAdminConfig() {
  return deepMerge(DEFAULT_ADMIN_CONFIG, getSetting('adminConfig', {}));
}

function saveAdminConfig(config) {
  const normalized = deepMerge(DEFAULT_ADMIN_CONFIG, config);
  saveSetting('adminConfig', normalized);
  return normalized;
}

function buildDistributedSnapshot(input = {}) {
  const now = new Date();
  const co = Number(input.co ?? input.coPpm ?? 18);
  const alcohol = Number(input.alcohol ?? input.alcoholPpm ?? 120);
  const voc = Number(input.voc ?? input.vocPpm ?? 180);
  const visionStatus = input.visionStatus || 'normal';
  const riskLevel = input.riskLevel || ((visionStatus !== 'normal' || co >= 80 || alcohol >= 700 || voc >= 700) ? 'danger' : (co >= 35 || alcohol >= 400 || voc >= 400) ? 'warning' : 'normal');
  return {
    timestamp: now.toISOString(),
    deviceId: input.deviceId || 'backend-dispatch',
    location: input.location || '后端管理台分发',
    riskLevel,
    reason: input.reason || '来自后端管理台的分发数据',
    action: input.action || (riskLevel === 'normal' ? '保持监测' : '按策略联动处理'),
    sensors: { co, alcohol, voc },
    vision: { status: visionStatus, label: input.visionLabel || '后端分发样本', confidence: Number(input.confidence ?? 0.96) },
    actuators: {
      fan: input.fan || (riskLevel === 'normal' ? '关闭' : '高速'),
      alarm: input.alarm || (riskLevel === 'normal' ? '未触发' : '已触发'),
      buzzer: input.buzzer || (riskLevel === 'normal' ? '静音' : '鸣响'),
      relay: input.relay || (riskLevel === 'normal' ? '断开' : '闭合')
    },
    uploadInterval: '后端分发'
  };
}

function ensureAccounts() {
  const count = authDb.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count === 0) {
    const insert = authDb.prepare(`
      INSERT INTO users (username, name, role, avatar, password_hash, password_salt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const account of DEFAULT_ACCOUNTS) {
      const password = hashPassword(account.password);
      insert.run(account.username, account.name, account.role, account.avatar, password.hash, password.salt, now, now);
    }
    console.log(`[labsafe] initialized SQLite account database: ${AUTH_DB_FILE}`);
  }
  if (!authDb.prepare("SELECT 1 FROM app_settings WHERE key = 'adminConfig'").get()) {
    saveAdminConfig(DEFAULT_ADMIN_CONFIG);
  }
}

function createToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

function getAuthUser(request) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + TOKEN_TTL_MS;
  return getUser(session.username);
}

function requireAuth(request, response) {
  const user = getAuthUser(request);
  if (!user) {
    sendJson(response, 401, { ok: false, message: '登录已失效，请重新登录' });
    return null;
  }
  return user;
}

function requireAdmin(request, response) {
  const user = requireAuth(request, response);
  if (!user) return null;
  if (user.role !== '管理员') {
    sendJson(response, 403, { ok: false, message: '仅管理员可管理账户' });
    return null;
  }
  return user;
}

function validateUserPayload(payload, { creating = false } = {}) {
  const username = String(payload.username || '').trim();
  const name = String(payload.name || '').trim();
  const role = String(payload.role || '观察员').trim();
  const password = String(payload.password || '');
  if (creating && !/^[A-Za-z0-9_-]{3,32}$/.test(username)) throw new Error('用户名需为 3-32 位字母、数字、下划线或短横线');
  if ((creating || name) && name.length < 1) throw new Error('姓名不能为空');
  if (!ROLE_PERMISSIONS[role]) throw new Error('角色无效');
  if (creating && password.length < 6) throw new Error('密码至少 6 位');
  if (!creating && password && password.length < 6) throw new Error('新密码至少 6 位');
  return { username, name, role, password };
}

function createUserAccount(payload) {
  if (getUser(payload.username)) throw new Error('用户名已存在');
  const password = hashPassword(payload.password);
  const now = new Date().toISOString();
  authDb.prepare(`
    INSERT INTO users (username, name, role, avatar, password_hash, password_salt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(payload.username, payload.name, payload.role, payload.name.slice(0, 1) || payload.username.slice(0, 1), password.hash, password.salt, now, now);
  return getUser(payload.username);
}

async function handleAuthApi(request, response, url) {
  if (url.pathname === '/api/login' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = getUser(username);
    if (!verifyPassword(password, user)) {
      sendJson(response, 401, { ok: false, message: '用户名或密码错误' });
      return true;
    }
    const token = createToken(user.username);
    sendJson(response, 200, { ok: true, token, account: publicAccount(user) });
    return true;
  }

  if (url.pathname === '/api/register' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const payload = validateUserPayload({ ...body, role: '观察员' }, { creating: true });
    const user = createUserAccount(payload);
    const token = createToken(user.username);
    sendJson(response, 201, { ok: true, token, account: publicAccount(user) });
    return true;
  }

  if (url.pathname === '/api/device/upload' && request.method === 'POST') {
    const body = await readJsonBody(request);
    if (body.debug || body.test || body.deviceId === 'wifi-node-001') {
      sendJson(response, 202, {
        ok: true,
        ignored: true,
        message: '测试上传已忽略，未进入用户端数据流'
      });
      return true;
    }
    const snapshot = acceptDevicePayload(body, {
      source: 'wifi',
      remoteAddress: request.socket.remoteAddress || null
    });
    sendJson(response, 200, {
      ok: true,
      message: 'WiFi 设备数据已接收',
      upload: state.upload,
      snapshot
    });
    return true;
  }

  if (url.pathname === '/api/me' && request.method === 'GET') {
    const user = requireAuth(request, response);
    if (!user) return true;
    sendJson(response, 200, { ok: true, account: publicAccount(user) });
    return true;
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token) sessions.delete(token);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/users' && request.method === 'GET') {
    if (!requireAdmin(request, response)) return true;
    sendJson(response, 200, { ok: true, users: getUsers().map((user) => publicAccount(user, true)) });
    return true;
  }

  if (url.pathname === '/api/admin/config' && request.method === 'GET') {
    const user = requireAuth(request, response);
    if (!user) return true;
    sendJson(response, 200, { ok: true, config: getAdminConfig(), canManage: user.role === '管理员' });
    return true;
  }

  if (url.pathname === '/api/admin/config' && request.method === 'PUT') {
    if (!requireAdmin(request, response)) return true;
    const body = await readJsonBody(request);
    const current = getAdminConfig();
    const config = saveAdminConfig(deepMerge(current, {
      dataMode: ['auto', 'mock', 'backend', 'device'].includes(body.dataMode) ? body.dataMode : current.dataMode,
      publishMockWhenOffline: typeof body.publishMockWhenOffline === 'boolean' ? body.publishMockWhenOffline : current.publishMockWhenOffline,
      modules: body.modules && typeof body.modules === 'object' ? body.modules : current.modules
    }));
    sendJson(response, 200, { ok: true, config });
    return true;
  }

  if (url.pathname === '/api/admin/distribute' && request.method === 'POST') {
    if (!requireAdmin(request, response)) return true;
    const body = await readJsonBody(request);
    const snapshot = buildDistributedSnapshot(body);
    state.connected = true;
    state.message = '已由后端管理台分发数据';
    state.updatedAt = new Date().toISOString();
    state.rawLine = 'BACKEND_DISTRIBUTED:' + JSON.stringify(snapshot);
    state.snapshot = normalizeSnapshot(snapshot);
    const config = saveAdminConfig(deepMerge(getAdminConfig(), {
      dataMode: 'backend',
      lastDistributedSnapshot: state.snapshot
    }));
    sendJson(response, 200, { ok: true, snapshot: state.snapshot, config });
    return true;
  }

  if (url.pathname === '/api/users' && request.method === 'POST') {
    if (!requireAdmin(request, response)) return true;
    const payload = validateUserPayload(await readJsonBody(request), { creating: true });
    const user = createUserAccount(payload);
    sendJson(response, 201, { ok: true, account: publicAccount(user, true) });
    return true;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && request.method === 'PUT') {
    if (!requireAdmin(request, response)) return true;
    const targetUsername = decodeURIComponent(userMatch[1]);
    const target = getUser(targetUsername);
    if (!target) throw new Error('账户不存在');
    const payload = validateUserPayload(await readJsonBody(request));
    const nextName = payload.name || target.name;
    const nextAvatar = (nextName || target.username).slice(0, 1);
    const now = new Date().toISOString();
    if (payload.password) {
      const password = hashPassword(payload.password);
      authDb.prepare(`
        UPDATE users SET name = ?, role = ?, avatar = ?, password_hash = ?, password_salt = ?, updated_at = ?
        WHERE username = ?
      `).run(nextName, payload.role, nextAvatar, password.hash, password.salt, now, targetUsername);
    } else {
      authDb.prepare('UPDATE users SET name = ?, role = ?, avatar = ?, updated_at = ? WHERE username = ?')
        .run(nextName, payload.role, nextAvatar, now, targetUsername);
    }
    sendJson(response, 200, { ok: true, account: publicAccount(getUser(targetUsername), true) });
    return true;
  }

  if (userMatch && request.method === 'DELETE') {
    const admin = requireAdmin(request, response);
    if (!admin) return true;
    const targetUsername = decodeURIComponent(userMatch[1]);
    if (targetUsername === admin.username) {
      sendJson(response, 400, { ok: false, message: '不能删除当前登录账户' });
      return true;
    }
    const target = getUser(targetUsername);
    if (!target) throw new Error('账户不存在');
    const adminCount = authDb.prepare("SELECT COUNT(*) AS count FROM users WHERE role = '管理员'").get().count;
    if (target.role === '管理员' && adminCount <= 1) throw new Error('至少保留一个管理员账户');
    authDb.prepare('DELETE FROM users WHERE username = ?').run(targetUsername);
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

function normalizeSnapshot(payload) {
  return {
    ...payload,
    receivedAt: new Date().toISOString(),
    bridge: {
      port: state.port,
      baud: SERIAL_BAUD,
      source: payload.bridgeSource || payload.source || 'windows-serialport',
      transport: payload.transport || 'serial'
    }
  };
}

function acceptDevicePayload(payload, { source, remoteAddress = null, rawLine = '' }) {
  const normalized = normalizeSnapshot({
    ...payload,
    bridgeSource: source === 'wifi' ? 'wifi-http-upload' : 'windows-serialport',
    transport: source
  });
  state.connected = true;
  state.message = source === 'wifi' ? '已接收 WiFi 设备上传数据' : '已接收 ESP32-P4 真实串口数据';
  state.updatedAt = new Date().toISOString();
  state.rawLine = rawLine || (source === 'wifi' ? 'WIFI_UPLOAD:' + JSON.stringify(payload) : '');
  state.snapshot = normalized;
  state.upload.lastSource = source;
  state.upload.lastDeviceId = payload.deviceId || payload.device?.id || null;
  state.upload.lastRemoteAddress = remoteAddress;
  state.upload.lastUploadAt = state.updatedAt;
  return normalized;
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function listAvailableSerialPorts() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', '[System.IO.Ports.SerialPort]::GetPortNames()'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error || result.status !== 0) return [];
  return Array.from(new Set(result.stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => /^COM\d+$/i.test(item))))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
}

function resolveSerialPort() {
  const availablePorts = listAvailableSerialPorts();
  const requested = String(REQUESTED_SERIAL_PORT).trim();
  state.availablePorts = availablePorts;
  const matchedPort = availablePorts.find((port) => port.toLowerCase() === requested.toLowerCase());
  if (matchedPort) {
    state.port = matchedPort;
    return matchedPort;
  }
  state.port = requested;
  state.connected = false;
  state.message = `未找到串口 ${requested}。当前可用串口：${availablePorts.join(', ') || '无'}。请重新插入 ESP32 设备，或使用 node tools\\labsafe_serial_bridge.mjs COMx 指定正确端口。`;
  return null;
}

function scheduleSerialRestart() {
  if (restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startSerialReader();
  }, SERIAL_RETRY_MS);
}

function handleMonitorLine(line) {
  const text = line.trim();
  if (!text) return;
  const prefixIndex = text.indexOf(TELEMETRY_PREFIX);
  if (prefixIndex < 0) return;
  const jsonText = text.slice(prefixIndex + TELEMETRY_PREFIX.length).trim();
  try {
    const payload = JSON.parse(jsonText);
    acceptDevicePayload(payload, { source: 'serial', rawLine: text });
    console.log('[labsafe] telemetry', state.updatedAt, jsonText);
  } catch (error) {
    state.message = `解析 JSON 失败：${error.message}`;
    console.warn('[labsafe] invalid telemetry line:', text);
  }
}

function clearNonDeviceSnapshot() {
  if (!state.rawLine || state.rawLine.startsWith(TELEMETRY_PREFIX) || state.rawLine.startsWith('WIFI_UPLOAD:')) return;
  state.connected = false;
  state.message = '等待器件通过串口或 WiFi 上传数据';
  state.updatedAt = null;
  state.rawLine = '';
  state.snapshot = null;
}

function startSerialReader() {
  if (serialProcess) return;
  const serialPort = resolveSerialPort();
  if (!serialPort) {
    console.warn(`[labsafe] ${state.message}`);
    scheduleSerialRestart();
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$portName = ${psString(serialPort)}
$baud = ${SERIAL_BAUD}
$port = [System.IO.Ports.SerialPort]::new($portName, $baud, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$port.Encoding = [System.Text.Encoding]::UTF8
$port.ReadTimeout = 1000
$port.DtrEnable = $true
$port.RtsEnable = $true
try {
  $port.Open()
  [Console]::Error.WriteLine('[labsafe-serial] opened ' + $portName + ' @ ' + $baud)
  while ($true) {
    try { [Console]::Out.WriteLine($port.ReadLine()) } catch [System.TimeoutException] {}
  }
} finally {
  if ($port -and $port.IsOpen) { $port.Close() }
}
`;
  console.log(`[labsafe] opening serial port directly: ${serialPort} @ ${SERIAL_BAUD}`);
  state.message = `正在监听 ${serialPort} @ ${SERIAL_BAUD}`;
  serialProcess = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { shell: false, windowsHide: true });
  let buffer = '';
  serialProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(handleMonitorLine);
  });
  serialProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text) console.warn('[serial]', text);
  });
  serialProcess.on('error', (error) => {
    state.connected = false;
    state.message = `启动串口读取器失败：${error.message}`;
    console.error('[labsafe] serial reader error:', error);
  });
  serialProcess.on('exit', (code, signal) => {
    serialProcess = null;
    state.connected = false;
    state.message = `串口读取器已退出 code=${code} signal=${signal}，${SERIAL_RETRY_MS / 1000} 秒后重试`;
    console.warn('[labsafe] serial reader exited:', code, signal);
    scheduleSerialRestart();
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  try {
    if (await handleAuthApi(request, response, url)) return;
  } catch (error) {
    sendJson(response, 400, { ok: false, message: error.message || '请求处理失败' });
    return;
  }
  if (url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      port: state.port,
      requestedPort: state.requestedPort,
      availablePorts: state.availablePorts,
      baud: SERIAL_BAUD,
      upload: state.upload,
      connected: state.connected,
      message: state.message,
      updatedAt: state.updatedAt,
      accountDatabase: AUTH_DB_FILE
    });
    return;
  }
  if (url.pathname === '/snapshot') {
    clearNonDeviceSnapshot();
    const config = getAdminConfig();
    const allowSnapshot = Boolean(state.snapshot && (state.rawLine.startsWith(TELEMETRY_PREFIX) || state.rawLine.startsWith('WIFI_UPLOAD:')));
    sendJson(response, 200, { ok: allowSnapshot, ...state, snapshot: allowSnapshot ? state.snapshot : null, adminConfig: config, ageMs: state.updatedAt ? Date.now() - Date.parse(state.updatedAt) : null });
    return;
  }
  sendJson(response, 404, { ok: false, message: 'Not Found. Use /health, /snapshot or /api/*.' });
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[labsafe] HTTP bridge: http://127.0.0.1:${HTTP_PORT}/snapshot`);
  console.log(`[labsafe] Account API: http://127.0.0.1:${HTTP_PORT}/api/login`);
  console.log(`[labsafe] Account DB: ${AUTH_DB_FILE}`);
  ensureAccounts();
  startSerialReader();
});
