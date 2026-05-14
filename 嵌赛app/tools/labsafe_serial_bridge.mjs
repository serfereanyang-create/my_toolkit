#!/usr/bin/env node
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUESTED_SERIAL_PORT = process.env.LABSAFE_PORT || process.argv[2] || 'COM9';
const SERIAL_BAUD = Number(process.env.LABSAFE_BAUD || process.argv[3] || 115200);
const HTTP_PORT = Number(process.env.LABSAFE_HTTP_PORT || process.argv[4] || 8765);
const TELEMETRY_PREFIX = 'LABSAFE_JSON:';
const SERIAL_RETRY_MS = 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.resolve(__dirname, '..', 'data', 'mock-state.json');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

const ROLE_PERMISSIONS = {
  管理员: ['查看实时监控', '查看数据窗口', '确认报警事件', '调整阈值策略', '管理账号密码'],
  操作员: ['查看实时监控', '查看数据窗口', '确认报警事件'],
  观察员: ['查看实时监控', '查看数据窗口']
};

const DEFAULT_ACCOUNTS = [
  {
    username: 'labadmin',
    name: '实验室管理员',
    role: '管理员',
    avatar: '管',
    passwordHash: 'fe5a00ecb34513d880f704156b39ceff14fbc47b021fb662607520a1906a4b66',
    passwordSalt: '88944b1a4d100252e39b318174e608b0'
  },
  {
    username: 'viewer',
    name: '安全观察员',
    role: '观察员',
    avatar: '观',
    passwordHash: 'dfd107071df1120a7aa9daa58274bc4bda1c10dcad6692f622aabf6b15f0114e',
    passwordSalt: 'e70115f576e4299fba06dcce484ac732'
  }
];

const sessions = new Map();

const state = {
  bridge: 'labsafe-serial-bridge',
  port: REQUESTED_SERIAL_PORT,
  requestedPort: REQUESTED_SERIAL_PORT,
  availablePorts: [],
  baud: SERIAL_BAUD,
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
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('JSON 格式错误'));
      }
    });
    request.on('error', reject);
  });
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    return { note: 'LabSafe 本地状态文件', modules: [] };
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2) + '\n', 'utf8');
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
  if (includeHashPreview) account.passwordHashPreview = `sha256:${String(user.passwordHash || '').slice(0, 10)}…`;
  return account;
}

function ensureAccounts() {
  const store = loadStore();
  if (!Array.isArray(store.accounts) || store.accounts.length === 0) {
    store.accounts = DEFAULT_ACCOUNTS.map((account) => {
      return {
        username: account.username,
        name: account.name,
        role: account.role,
        avatar: account.avatar,
        passwordHash: account.passwordHash,
        passwordSalt: account.passwordSalt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });
    saveStore(store);
    console.log(`[labsafe] initialized encrypted accounts in ${DATA_FILE}`);
  }
  return store;
}

function getUsers() {
  return ensureAccounts().accounts || [];
}

function updateUsers(mutator) {
  const store = ensureAccounts();
  const users = Array.isArray(store.accounts) ? store.accounts : [];
  mutator(users);
  store.accounts = users;
  saveStore(store);
  return users;
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
  return getUsers().find((user) => user.username === session.username) || null;
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

async function handleAuthApi(request, response, url) {
  if (url.pathname === '/api/login' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = getUsers().find((item) => item.username === username);
    if (!verifyPassword(password, user)) {
      sendJson(response, 401, { ok: false, message: '用户名或密码错误' });
      return true;
    }
    const token = createToken(user.username);
    sendJson(response, 200, { ok: true, token, account: publicAccount(user) });
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

  if (url.pathname === '/api/users' && request.method === 'POST') {
    if (!requireAdmin(request, response)) return true;
    const payload = validateUserPayload(await readJsonBody(request), { creating: true });
    let created = null;
    updateUsers((users) => {
      if (users.some((user) => user.username === payload.username)) throw new Error('用户名已存在');
      const password = hashPassword(payload.password);
      created = {
        username: payload.username,
        name: payload.name,
        role: payload.role,
        avatar: payload.name.slice(0, 1) || payload.username.slice(0, 1),
        passwordHash: password.hash,
        passwordSalt: password.salt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      users.push(created);
    });
    sendJson(response, 201, { ok: true, account: publicAccount(created, true) });
    return true;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && request.method === 'PUT') {
    if (!requireAdmin(request, response)) return true;
    const targetUsername = decodeURIComponent(userMatch[1]);
    const payload = validateUserPayload(await readJsonBody(request));
    let updated = null;
    updateUsers((users) => {
      const target = users.find((user) => user.username === targetUsername);
      if (!target) throw new Error('账户不存在');
      if (payload.name) target.name = payload.name;
      target.role = payload.role;
      target.avatar = (target.name || target.username).slice(0, 1);
      if (payload.password) {
        const password = hashPassword(payload.password);
        target.passwordHash = password.hash;
        target.passwordSalt = password.salt;
      }
      target.updatedAt = new Date().toISOString();
      updated = target;
    });
    sendJson(response, 200, { ok: true, account: publicAccount(updated, true) });
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
    updateUsers((users) => {
      const index = users.findIndex((user) => user.username === targetUsername);
      if (index < 0) throw new Error('账户不存在');
      const target = users[index];
      if (target.role === '管理员' && users.filter((user) => user.role === '管理员').length <= 1) throw new Error('至少保留一个管理员账户');
      users.splice(index, 1);
    });
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
      source: 'windows-serialport'
    }
  };
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
  return Array.from(new Set(
    result.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter((item) => /^COM\d+$/i.test(item))
  )).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
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
    state.connected = true;
    state.message = '已接收 ESP32-P4 真实串口数据';
    state.updatedAt = new Date().toISOString();
    state.rawLine = text;
    state.snapshot = normalizeSnapshot(payload);
    console.log('[labsafe] telemetry', state.updatedAt, jsonText);
  } catch (error) {
    state.message = `解析 JSON 失败：${error.message}`;
    console.warn('[labsafe] invalid telemetry line:', text);
  }
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
    try {
      $line = $port.ReadLine()
      [Console]::Out.WriteLine($line)
    } catch [System.TimeoutException] {
    }
  }
} finally {
  if ($port -and $port.IsOpen) { $port.Close() }
}
`;

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
  console.log(`[labsafe] opening serial port directly: ${serialPort} @ ${SERIAL_BAUD}`);
  state.message = `正在监听 ${serialPort} @ ${SERIAL_BAUD}`;

  serialProcess = spawn('powershell.exe', args, {
    shell: false,
    windowsHide: true
  });

  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(handleMonitorLine);
  };

  serialProcess.stdout.on('data', onData);
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
      connected: state.connected,
      message: state.message,
      updatedAt: state.updatedAt
    });
    return;
  }

  if (url.pathname === '/snapshot') {
    sendJson(response, 200, {
      ok: Boolean(state.snapshot),
      ...state,
      ageMs: state.updatedAt ? Date.now() - Date.parse(state.updatedAt) : null
    });
    return;
  }

  sendJson(response, 404, { ok: false, message: 'Not Found. Use /health, /snapshot or /api/*.' });
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[labsafe] HTTP bridge: http://127.0.0.1:${HTTP_PORT}/snapshot`);
  console.log(`[labsafe] Account API: http://127.0.0.1:${HTTP_PORT}/api/login`);
  ensureAccounts();
  startSerialReader();
});

function shutdown() {
  if (restartTimer) clearTimeout(restartTimer);
  if (serialProcess) serialProcess.kill();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);