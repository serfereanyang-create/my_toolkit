const LABSAFE_AUTH_URL = window.location.origin.startsWith('http') ? window.location.origin : 'http://127.0.0.1:8765';
const LABSAFE_BRIDGE_URL = 'http://127.0.0.1:8765/snapshot';
const LABSAFE_TELEMETRY_PREFIX = 'LABSAFE_JSON:';
const FAN_FULL_LOAD_RPM = 8000;
const state = { history: { co: [], alcohol: [], voc: [] }, alarms: [], events: [], current: null, account: null, authToken: localStorage.getItem('labsafe-auth-token') || '', chartTypes: ['co', 'alcohol', 'voc'], query: { sensorType: 'co', startSeconds: 0, endSeconds: 2 }, sensorSampling: { co: 1, alcohol: 1, voc: 1 }, sensorLastSampleAt: { co: -Infinity, alcohol: -Infinity, voc: -Infinity }, sampleSequence: { co: 0, alcohol: 0, voc: 0 }, mockElapsedSeconds: 0, dataSource: 'mock', bridge: { enabled: true, url: LABSAFE_BRIDGE_URL, connected: false, lastUpdatedAt: null, failureCount: 0, message: '等待本地真实数据桥接服务' }, serial: { supported: typeof navigator !== 'undefined' && 'serial' in navigator, connected: false, connecting: false, port: null, authorizedPorts: [], portLabel: '未选择', message: '等待串口检测', lastRawLine: '', lastError: '', grantedPorts: [], candidates: [] } };
const pageTitles = { home: '主页', data: '数据窗口', settings: '设置' };
const chartTypeLabels = { co: 'CO', alcohol: '酒精', voc: 'VOC' };
const chartViews = {};
const sensorMeta = [
  { key: 'co', label: 'SC16-CO', unit: 'ppm', warning: 35, danger: 80 },
  { key: 'alcohol', label: '酒精气体', unit: 'ppm', warning: 400, danger: 700 },
  { key: 'voc', label: 'SGP40 VOC', unit: 'ppm', warning: 400, danger: 700 },
  { key: 'air', label: '综合空气状态', unit: '', warning: 1, danger: 2 }
];
const visionLabels = {
  normal: '未发现异常',
  alcohol_lamp_on: '酒精灯处于开启状态',
  container_open: '疑似容器未盖合',
  object_misplaced: '实验器材摆放异常',
  operation_risk: '疑似人员危险操作'
};
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function formatTime(date) { return date.toLocaleString('zh-CN', { hour12: false }); }
function levelText(level) { return { normal: '正常', warning: '预警', danger: '危险' }[level] || level; }
function getLevel(value, warning, danger) { if (value >= danger) return 'danger'; if (value >= warning) return 'warning'; return 'normal'; }
function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
function setRiskClass(el, level) { if (!el) return; el.classList.remove('risk-normal', 'risk-warning', 'risk-danger'); el.classList.add('risk-' + level); }
function buildSnapshot() {
  const abnormal = Math.random() > 0.72;
  const visionStatus = abnormal ? pick(['normal', 'alcohol_lamp_on', 'container_open', 'object_misplaced', 'operation_risk']) : 'normal';
  const co = abnormal ? randomInt(20, 95) : randomInt(3, 26);
  const alcohol = abnormal ? randomInt(250, 820) : randomInt(80, 260);
  const voc = abnormal ? randomInt(260, 780) : randomInt(60, 280);
  const levels = [getLevel(co, 35, 80), getLevel(alcohol, 400, 700), getLevel(voc, 400, 700)];
  const riskLevel = levels.includes('danger') || visionStatus !== 'normal' ? 'danger' : levels.includes('warning') ? 'warning' : 'normal';
  const reasons = [];
  if (co >= 80) reasons.push('CO 浓度达到危险阈值'); else if (co >= 35) reasons.push('CO 浓度接近风险阈值');
  if (alcohol >= 700) reasons.push('酒精气体达到危险阈值'); else if (alcohol >= 400) reasons.push('酒精气体接近风险阈值');
  if (voc >= 700) reasons.push('VOC 指标达到危险阈值'); else if (voc >= 400) reasons.push('VOC 指标接近风险阈值');
  if (visionStatus !== 'normal') reasons.push('视觉识别发现异常状态');
  return {
    timestamp: formatTime(new Date()),
    riskLevel,
    reason: reasons.length ? reasons.join('；') : '环境状态正常，持续监测中。',
    action: riskLevel === 'danger' ? '报警并开启高档通风' : riskLevel === 'warning' ? '提示检查并准备通风' : '保持监测',
    sensors: { co, alcohol, voc, air: riskLevel === 'danger' ? 2 : riskLevel === 'warning' ? 1 : 0 },
    vision: { status: visionStatus, label: visionLabels[visionStatus], confidence: visionStatus === 'normal' ? randomInt(92, 99) : randomInt(76, 94) },
    actuators: { fan: riskLevel === 'danger' ? '高速' : riskLevel === 'warning' ? '低速' : '关闭', alarm: riskLevel === 'danger' ? '已触发' : '未触发', buzzer: riskLevel === 'danger' ? '鸣响' : '静音', relay: riskLevel === 'normal' ? '断开' : '闭合' },
    device: { id: 'lab-node-001', online: '在线', location: '实验操作台 1', power: randomInt(74, 100) + '%', wifi: '-' + randomInt(45, 68) + ' dBm', uploadInterval: '3s' }
  };
}
function buildWaitingSnapshot() {
  return {
    timestamp: formatTime(new Date()),
    riskLevel: 'normal',
    reason: '等待 ESP32-P4 真实数据输入。',
    action: '等待真实设备接入',
    sensors: { co: '--', alcohol: '--', voc: '--', air: 0 },
    vision: { status: 'waiting', label: '等待真实视觉/传感器数据', confidence: 0 },
    actuators: { fan: '等待数据', alarm: '等待数据', buzzer: '等待数据', relay: '等待数据' },
    device: { id: 'esp32-p4', online: '等待连接', location: '串口实时接入', power: '--', wifi: '--', uploadInterval: '收到真实数据后刷新' }
  };
}
function authHeaders(extra = {}) {
  return Object.assign({ 'Content-Type': 'application/json' }, state.authToken ? { Authorization: 'Bearer ' + state.authToken } : {}, extra);
}
async function authRequest(path, options = {}) {
  const response = await fetch(LABSAFE_AUTH_URL + path, Object.assign({}, options, {
    headers: authHeaders(options.headers || {})
  }));
  const data = await response.json().catch(function () { return { ok: false, message: '后台返回异常' }; });
  if (!response.ok || !data.ok) throw new Error(data.message || '请求失败');
  return data;
}
function isAdminAccount() {
  return state.account && state.account.role === '管理员';
}
async function setupAuth() {
  showLogin();
  if (state.authToken) {
    try {
      const data = await authRequest('/api/me', { method: 'GET' });
      state.account = data.account;
      hideLogin();
      renderAccount();
      setupAccountAdmin();
    } catch (error) {
      state.authToken = '';
      localStorage.removeItem('labsafe-auth-token');
      setText('login-message', '请登录本地账号后台。');
    }
  }

  const form = document.getElementById('login-form');
  const accountEntry = document.getElementById('account-entry');
  const accountEntrySide = document.getElementById('account-entry-side');
  const close = document.getElementById('account-modal-close');
  const logout = document.getElementById('logout-button');

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    try {
      setText('login-message', '正在连接本地账号后台...');
      const data = await authRequest('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      state.authToken = data.token;
      state.account = data.account;
      localStorage.setItem('labsafe-auth-token', data.token);
      setText('login-message', '');
      hideLogin();
      renderAccount();
      setupAccountAdmin();
      loadAccountUsers();
    } catch (error) {
      setText('login-message', error.message + '。请确认已运行：node tools/labsafe_serial_bridge.mjs');
    }
  });

  accountEntry.addEventListener('click', openAccountModal);
  accountEntrySide.addEventListener('click', openAccountModal);
  close.addEventListener('click', closeAccountModal);
  document.getElementById('account-modal').addEventListener('click', function (event) {
    if (event.target.id === 'account-modal') closeAccountModal();
  });
  logout.addEventListener('click', async function () {
    try { await authRequest('/api/logout', { method: 'POST' }); } catch (error) {}
    state.account = null;
    state.authToken = '';
    localStorage.removeItem('labsafe-auth-token');
    closeAccountModal();
    showLogin();
    renderAccount();
    renderAccountAdminLocked();
  });
}
function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.body.classList.add('locked');
}
function hideLogin() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.body.classList.remove('locked');
}
function openAccountModal() {
  if (!state.account) {
    showLogin();
    return;
  }
  renderAccount();
  document.getElementById('account-modal').hidden = false;
}
function closeAccountModal() {
  document.getElementById('account-modal').hidden = true;
}
function renderAccount() {
  const account = state.account;
  const name = account ? account.name : '未登录';
  const role = account ? account.role : '点击进行账户准入';
  const avatar = account ? account.avatar : '未';
  setText('account-name', name);
  setText('account-avatar', avatar);
  setText('side-account-name', name);
  setText('side-account-role', role);
  setText('side-account-avatar', avatar);
  setText('modal-account-name', name);
  setText('modal-account-role', role);
  setText('modal-account-avatar', avatar);

  const list = document.getElementById('modal-permission-list');
  list.innerHTML = '';
  (account ? account.permissions : ['未登录']).forEach(function (permission) {
    const item = document.createElement('li');
    item.textContent = permission;
    list.appendChild(item);
  });
}
function renderAccountAdminLocked() {
  const body = document.getElementById('account-user-table-body');
  if (body) body.innerHTML = '<tr><td colspan="6" class="muted">请使用管理员账户登录后管理用户。</td></tr>';
  setText('account-admin-status', '仅管理员可管理账户。');
}
let accountAdminBound = false;
function setupAccountAdmin() {
  const form = document.getElementById('account-create-form');
  const refresh = document.getElementById('account-refresh-button');
  if (!form || accountAdminBound) {
    if (isAdminAccount()) loadAccountUsers(); else renderAccountAdminLocked();
    return;
  }
  accountAdminBound = true;
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!isAdminAccount()) return renderAccountAdminLocked();
    try {
      const payload = {
        username: document.getElementById('account-new-username').value.trim(),
        name: document.getElementById('account-new-name').value.trim(),
        role: document.getElementById('account-new-role').value,
        password: document.getElementById('account-new-password').value
      };
      await authRequest('/api/users', { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      setText('account-admin-status', '账户已新增。');
      loadAccountUsers();
    } catch (error) {
      setText('account-admin-status', error.message);
    }
  });
  if (refresh) refresh.addEventListener('click', loadAccountUsers);
  if (isAdminAccount()) loadAccountUsers(); else renderAccountAdminLocked();
}
async function loadAccountUsers() {
  const body = document.getElementById('account-user-table-body');
  if (!body) return;
  if (!isAdminAccount()) return renderAccountAdminLocked();
  try {
    const data = await authRequest('/api/users', { method: 'GET' });
    renderAccountUserTable(data.users || []);
    setText('account-admin-status', '已加载 ' + (data.users || []).length + ' 个账户。密码均为加密哈希保存，不显示明文。');
  } catch (error) {
    body.innerHTML = '<tr><td colspan="6" class="muted">' + error.message + '</td></tr>';
    setText('account-admin-status', error.message);
  }
}
function renderAccountUserTable(users) {
  const body = document.getElementById('account-user-table-body');
  if (!body) return;
  body.innerHTML = '';
  users.forEach(function (user) {
    const row = document.createElement('tr');
    const createdAt = user.createdAt ? String(user.createdAt).replace('T', ' ').slice(0, 19) : '--';
    row.innerHTML = '<td><strong>' + user.username + '</strong><div class="account-hash-note">' + user.passwordHashPreview + '</div></td>' +
      '<td><input class="account-name-input" value="' + user.name + '" /></td>' +
      '<td><select class="account-role-input"><option value="管理员">管理员</option><option value="操作员">操作员</option><option value="观察员">观察员</option></select></td>' +
      '<td>' + (user.permissions || []).join('<br>') + '</td>' +
      '<td>' + createdAt + '</td>' +
      '<td><div class="account-actions"><input class="account-password-input" type="password" placeholder="新密码，不改可留空" /><div class="account-action-row"><button class="account-small-button" type="button" data-action="save">保存</button><button class="account-danger-button" type="button" data-action="delete">删除</button></div></div></td>';
    const roleInput = row.querySelector('.account-role-input');
    roleInput.value = user.role;
    row.querySelector('[data-action="save"]').addEventListener('click', async function () {
      try {
        const payload = {
          name: row.querySelector('.account-name-input').value.trim(),
          role: roleInput.value,
          password: row.querySelector('.account-password-input').value
        };
        await authRequest('/api/users/' + encodeURIComponent(user.username), { method: 'PUT', body: JSON.stringify(payload) });
        setText('account-admin-status', '账户 ' + user.username + ' 已更新。');
        loadAccountUsers();
      } catch (error) {
        setText('account-admin-status', error.message);
      }
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', async function () {
      if (!confirm('确定删除账户 ' + user.username + ' 吗？')) return;
      try {
        await authRequest('/api/users/' + encodeURIComponent(user.username), { method: 'DELETE' });
        setText('account-admin-status', '账户 ' + user.username + ' 已删除。');
        loadAccountUsers();
      } catch (error) {
        setText('account-admin-status', error.message);
      }
    });
    body.appendChild(row);
  });
}
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(function (button) {
    button.addEventListener('click', function () {
      const page = button.dataset.page;
      document.querySelectorAll('.nav-item').forEach(function (item) { item.classList.toggle('active', item === button); });
      document.querySelectorAll('.page-section').forEach(function (section) { section.classList.toggle('active', section.id === 'page-' + page); });
      setText('page-title', pageTitles[page] || '主页');
      if (page === 'data') { renderTrends(); applyChartMode(); }
    });
  });
}
function setupChartModeSelector() {
  document.querySelectorAll('.chart-type-check').forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      const checked = Array.from(document.querySelectorAll('.chart-type-check:checked')).map(function (item) {
        return item.value;
      });
      if (checked.length === 0) {
        checkbox.checked = true;
        state.chartTypes = [checkbox.value];
      } else {
        state.chartTypes = checked.slice(0, 3);
      }
      applyChartMode();
      renderTrends();
    });
  });

  const queryType = document.getElementById('query-sensor-type');
  const queryStart = document.getElementById('query-start-seconds');
  const queryEnd = document.getElementById('query-end-seconds');
  const queryButton = document.getElementById('query-sensor-range');
  if (queryType) {
    queryType.value = state.query.sensorType;
    queryType.addEventListener('change', function () {
      state.query.sensorType = queryType.value;
      syncQueryRangeInput();
    });
  }
  if (queryStart) {
    queryStart.addEventListener('input', function () {
      state.query.startSeconds = Math.max(0, Number(queryStart.value || 0));
    });
    queryStart.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') querySensorRangeStats();
    });
  }
  if (queryEnd) {
    queryEnd.addEventListener('input', function () {
      const maxEnd = Math.max(2, getAvailableQueryRange(state.query.sensorType));
      state.query.endSeconds = clamp(Number(queryEnd.value || 2), 2, maxEnd);
    });
    queryEnd.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') querySensorRangeStats();
    });
  }
  if (queryButton) queryButton.addEventListener('click', querySensorRangeStats);
  syncQueryRangeInput();

  const exportButton = document.getElementById('export-data-button');
  if (exportButton) exportButton.addEventListener('click', exportData);
  const exportStart = document.getElementById('export-start-seconds');
  const exportEnd = document.getElementById('export-end-seconds');
  [exportStart, exportEnd].forEach(function (input) {
    if (!input) return;
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') exportData();
    });
  });

  applyChartMode();
}
function syncQueryRangeInput() {
  const startInput = document.getElementById('query-start-seconds');
  const endInput = document.getElementById('query-end-seconds');
  const maxRange = Math.max(2, getAvailableQueryRange(state.query.sensorType));
  state.query.startSeconds = clamp(Number(state.query.startSeconds || 0), 0, maxRange);
  state.query.endSeconds = clamp(Number(state.query.endSeconds || 2), 2, maxRange);
  if (state.query.endSeconds < state.query.startSeconds) state.query.endSeconds = state.query.startSeconds;
  if (startInput) { startInput.min = '0'; startInput.max = String(maxRange); startInput.value = String(state.query.startSeconds); }
  if (endInput) { endInput.min = '2'; endInput.max = String(maxRange); endInput.value = String(state.query.endSeconds); }
}
function querySensorRangeStats() {
  const sensorKey = state.query.sensorType;
  const history = state.history[sensorKey] || [];
  if (!history.length) {
    setText('query-result', '当前没有可查询的数据');
    return;
  }
  const availableRange = getAvailableQueryRange(sensorKey);
  const maxRange = Math.max(2, availableRange);
  const startSeconds = clamp(Number(state.query.startSeconds || 0), 0, maxRange);
  const endSeconds = clamp(Number(state.query.endSeconds || 2), Math.max(2, startSeconds), maxRange);
  state.query.startSeconds = startSeconds;
  state.query.endSeconds = endSeconds;
  syncQueryRangeInput();

  const originElapsedSeconds = history[0].elapsedSeconds;
  const samples = history.filter(function (sample) {
    const t = sample.elapsedSeconds - originElapsedSeconds;
    return t >= startSeconds && t <= endSeconds;
  });
  if (!samples.length) {
    setText('query-result', '当前区间内没有可统计的数据');
    return;
  }
  const values = samples.map(function (sample) { return Number(sample.value); });
  const minValue = Math.min.apply(null, values);
  const maxValue = Math.max.apply(null, values);
  const avgValue = (values.reduce(function (sum, value) { return sum + value; }, 0) / values.length).toFixed(2);
  const labelMap = { co: 'CO', alcohol: '酒精气体', voc: 'VOC' };
  setText('query-result', labelMap[sensorKey] + ' 在 ' + startSeconds + 's 到 ' + endSeconds + 's 区间内：最低 ' + minValue + ' ppm，最高 ' + maxValue + ' ppm，平均 ' + avgValue + ' ppm（' + values.length + ' 点）');
}
function applyChartMode() {
  const selected = state.chartTypes.slice(0, 3);
  document.querySelectorAll('.trend-grid > [data-trend-key]').forEach(function (item) {
    item.hidden = !selected.includes(item.dataset.trendKey);
  });
  const grid = document.querySelector('.trend-grid');
  if (grid) grid.classList.toggle('single', selected.length === 1);
  const label = selected.map(function (key) { return chartTypeLabels[key] || key; }).join(' / ');
  setText('chart-mode-desc', '当前显示：' + label + '（按各自窗口刷新）');
}

function renderSummary(snapshot) {
  const risk = document.getElementById('system-risk');
  setRiskClass(risk, snapshot.riskLevel);
  setText('system-risk', levelText(snapshot.riskLevel));
  setText('home-risk', levelText(snapshot.riskLevel));
  setText('home-action', snapshot.action);
  setText('last-updated', '更新时间：' + snapshot.timestamp);
  setText('global-status', snapshot.riskLevel === 'normal' ? '系统运行中' : '需要关注');
  setText('side-device-id', snapshot.device.id);
  setText('side-device-status', '节点' + snapshot.device.online + ' · ' + snapshot.device.uploadInterval + ' 刷新');
}
function renderSensors(snapshot) {
  const grid = document.getElementById('sensor-grid');
  const table = document.getElementById('data-sensor-table-body');
  grid.innerHTML = '';
  table.innerHTML = '';
  sensorMeta.forEach(function (sensor) {
    const raw = snapshot.sensors[sensor.key];
    const display = sensor.key === 'air' ? levelText(snapshot.riskLevel) : raw;
    const level = sensor.key === 'air' ? snapshot.riskLevel : getLevel(raw, sensor.warning, sensor.danger);
    const card = document.createElement('article');
    card.className = 'sensor-card';
    card.innerHTML = '<span class="label">' + sensor.label + '</span><strong class="value">' + display + '</strong><span class="unit">' + sensor.unit + '</span><div class="state"><span class="risk-pill risk-' + level + '">' + levelText(level) + '</span></div>';
    grid.appendChild(card);
    const row = document.createElement('tr');
    row.innerHTML = '<td>' + sensor.label + '</td><td>' + display + '</td><td>' + sensor.unit + '</td><td><span class="risk-pill risk-' + level + '">' + levelText(level) + '</span></td>';
    table.appendChild(row);
  });
}
function renderVision(snapshot) {
  setText('vision-main', snapshot.vision.status);
  setText('vision-label', snapshot.vision.label);
  setText('vision-confidence', snapshot.vision.confidence + '%');
  setText('vision-chip', snapshot.vision.status === 'normal' ? '视觉正常' : '发现异常');
}
function renderStatusList(id, rows) {
  const list = document.getElementById(id);
  list.innerHTML = '';
  rows.forEach(function (row) {
    const item = document.createElement('div');
    item.className = 'status-item';
    item.innerHTML = '<span>' + row.label + '</span><strong>' + row.value + '</strong>';
    list.appendChild(item);
  });
}
function fanCommandLabel(snapshot) {
  const actuators = snapshot.actuators || {};
  const rawFan = String(actuators.fan || '').toLowerCase();
  const pwm = getFanPwmEstimate(snapshot).pwm;
  const commanded = Boolean(actuators.fanCommanded ?? snapshot.fanCommanded ?? (pwm > 0 || ['low', 'high', 'on', '低速', '高速', '开启'].includes(rawFan)));
  if (!commanded || pwm <= 0 || rawFan === 'off' || rawFan === '关闭') return '程序命令：关闭';
  if (pwm >= 80 || rawFan === 'high' || rawFan === '高速') return '程序命令：高速 ' + pwm + '%';
  return '程序命令：低速 ' + pwm + '%';
}
function getFanPwmEstimate(snapshot) {
  const actuators = snapshot.actuators || {};
  const rawFan = String(actuators.fan || '').toLowerCase();
  let pwm = Number(actuators.fanPwmPercent ?? actuators.fanPercent ?? snapshot.fanPwmPercent ?? snapshot.fanPercent);
  if (!Number.isFinite(pwm)) {
    if (rawFan === 'high' || rawFan === '高速') pwm = 85;
    else if (['low', 'on', '低速', '开启'].includes(rawFan)) pwm = 40;
    else pwm = 0;
  }
  pwm = clamp(pwm, 0, 100);
  return { pwm, rpm: Math.round(FAN_FULL_LOAD_RPM * pwm / 100) };
}
function fanWorkStateLabel(snapshot) {
  const actuators = snapshot.actuators || {};
  const estimate = getFanPwmEstimate(snapshot);
  const hasFeedback = actuators.fanTachRpm != null || snapshot.fanTachRpm != null;
  const rpm = Number(actuators.fanTachRpm ?? snapshot.fanTachRpm ?? 0);
  if (hasFeedback) return rpm > 0 ? ('测速转速：' + rpm + ' RPM；等效估算：' + estimate.rpm + ' RPM') : '异常：有 PWM 命令但测速为 0 RPM';
  if (estimate.pwm > 0) return '等效转速：约 ' + estimate.rpm + ' RPM（按 12V 满载 ' + FAN_FULL_LOAD_RPM + ' RPM × ' + estimate.pwm + '% PWM 估算）';
  return '等效转速：0 RPM';
}
function renderActuators(snapshot) {
  renderStatusList('actuator-list', [
    { label: '排气风机', value: fanCommandLabel(snapshot) },
    { label: '风扇等效转速', value: fanWorkStateLabel(snapshot) },
    { label: 'PWM 输出参数', value: 'GPIO' + (snapshot.actuators.fanPwmPin ?? '4') + ' · ' + (snapshot.actuators.fanPwmFreqHz ?? '20000') + 'Hz' },
    { label: '报警状态', value: snapshot.actuators.alarm },
    { label: '蜂鸣器', value: snapshot.actuators.buzzer },
    { label: '继电器输出', value: snapshot.actuators.relay }
  ]);
}
function renderDevice(snapshot) {
  renderStatusList('device-list', [
    { label: '设备编号', value: snapshot.device.id },
    { label: '部署位置', value: snapshot.device.location },
    { label: '在线状态', value: snapshot.device.online },
    { label: '电量', value: snapshot.device.power },
    { label: 'Wi-Fi', value: snapshot.device.wifi },
    { label: '上传间隔', value: snapshot.device.uploadInterval }
  ]);
}
function getBoardDetectScan() {
  const scan = window.__LABSAFE_DEVICE_SCAN__;
  if (!scan || typeof scan !== 'object') return null;
  return scan;
}
function getBoardDetectCandidates(scan) {
  return (scan && Array.isArray(scan.devices) ? scan.devices : []).filter(function (device) {
    return device && (device.isEspressif || device.isUsbBridge || device.isEsp32P4 || device.boardType || device.com);
  });
}
function syncSerialCandidatesFromScan(scan) {
  const seenPorts = new Set();
  state.serial.candidates = getBoardDetectCandidates(scan).filter(function (device) {
    return !!(device && device.com);
  }).map(function (device) {
    const port = String(device.com).toUpperCase();
    if (seenPorts.has(port)) return null;
    seenPorts.add(port);
    return {
      port,
      usb: device.usbId || 'USB ID 未提供',
      note: device.boardType || '开发板候选'
    };
  }).filter(Boolean);
}
function renderBoardDetectionStatus() {
  const scan = getBoardDetectScan();
  if (!scan) {
    state.serial.candidates = [];
    setText('board-detect-chip', '无扫描结果');
    setText('board-detect-type', '未检测');
    setText('board-detect-port', '未提供');
    setText('board-detect-p4', '未知');
    setText('board-detect-count', '0');
    setText('board-detect-source', '尚未加载本地扫描结果');
    setText('board-detect-detail', '未发现开发板候选');
    renderRealDeviceCard();
    return;
  }
  const candidates = getBoardDetectCandidates(scan);
  syncSerialCandidatesFromScan(scan);
  const recommendedDevice = candidates.find(function (device) {
    return device.com === scan.recommendedPort;
  }) || candidates.find(function (device) {
    return device.boardType === scan.recommendedBoard;
  }) || candidates[0] || null;
  const boardType = scan.recommendedBoard || (recommendedDevice && recommendedDevice.boardType) || '未知开发板';
  const recommendedPort = scan.recommendedPort || (recommendedDevice && recommendedDevice.com) || '未提供';
  const isP4 = typeof scan.recommendedIsP4 === 'boolean' ? scan.recommendedIsP4 : !!(recommendedDevice && recommendedDevice.isEsp32P4);
  const candidateCount = Number(scan.candidateCount ?? scan.total ?? candidates.length) || candidates.length;
  const preferredBoards = (scan.preferredBoards || []).filter(Boolean);
  const scanTime = scan.scannedAt ? String(scan.scannedAt).replace('T', ' ') : '未知时间';
  setText('board-detect-chip', candidateCount > 0 ? '已加载扫描' : '未发现候选');
  setText('board-detect-type', boardType);
  setText('board-detect-port', recommendedPort);
  setText('board-detect-p4', isP4 ? '是' : '否');
  setText('board-detect-count', String(candidateCount));
  setText('board-detect-source', '扫描时间：' + scanTime);
  setText('board-detect-detail', preferredBoards.length ? ('候选板型：' + preferredBoards.join(' / ')) : '未发现开发板候选');
  renderRealDeviceCard();
}
function renderRealDeviceCard() {
  const bridgeOnline = state.bridge.connected;
  const hasAuthorizedPort = state.serial.grantedPorts.length > 0;
  const serialStatus = state.serial.connected ? '已连接' : (state.serial.connecting ? '正在打开' : (hasAuthorizedPort ? '已授权，待打开' : '未连接'));
  const displayPort = state.serial.connected
    ? state.serial.portLabel
    : (hasAuthorizedPort ? state.serial.grantedPorts[0].label : (state.serial.portLabel || '未选择'));
  setText('serial-support-chip', bridgeOnline ? '真实数据已接入' : (state.serial.supported ? '浏览器支持串口' : '等待本地桥接'));
  setText('serial-connect-state', bridgeOnline ? '已连接' : serialStatus);
  setText('serial-current-port', bridgeOnline ? '本地桥接：' + state.bridge.url : ('当前端口：' + displayPort));
  const totalCandidates = state.serial.candidates.length + state.serial.grantedPorts.length;
  setText('serial-candidate-count', String(totalCandidates));
  const serialDetail = state.serial.lastError
    ? state.serial.message + '；错误：' + state.serial.lastError
    : state.serial.message;
  setText('serial-message', bridgeOnline ? state.bridge.message : serialDetail);
  const list = document.getElementById('serial-candidate-list');
  if (!list) return;
  list.innerHTML = '';
  const rows = [];
  if (bridgeOnline || state.bridge.failureCount > 0) {
    rows.push({ title: bridgeOnline ? 'ESP32-P4 HTTP 桥接在线' : 'ESP32-P4 HTTP 桥接未连接', detail: state.bridge.message + ' · ' + state.bridge.url });
  }
  state.serial.candidates.forEach(function (item) {
    rows.push({ title: item.port, detail: item.usb + ' · ' + item.note });
  });
  state.serial.grantedPorts.forEach(function (item) {
    rows.push({ title: item.label, detail: item.note });
  });
  rows.forEach(function (row) {
    const card = document.createElement('article');
    card.className = 'serial-candidate-item';
    card.innerHTML = '<strong>' + row.title + '</strong><span>' + row.detail + '</span>';
    list.appendChild(card);
  });
}
function normalizeIncomingSnapshot(payload) {
  const co = Number(payload.coPpm ?? payload.co ?? payload.sensors?.co ?? 0);
  const alcohol = Number(payload.alcoholPpm ?? payload.alcohol ?? payload.sensors?.alcohol ?? 0);
  const voc = Number(payload.vocPpm ?? payload.voc ?? payload.sensors?.voc ?? 0);
  const visionStatus = payload.vision?.status || payload.visionStatus || 'normal';
  const riskLevel = payload.riskLevel || ((visionStatus !== 'normal' || co >= 80 || alcohol >= 700 || voc >= 700) ? 'danger' : (co >= 35 || alcohol >= 400 || voc >= 400) ? 'warning' : 'normal');
  return {
    timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : formatTime(new Date(payload.timestamp || Date.now())),
    riskLevel,
    reason: payload.reason || payload.riskReason || '来自串口实时数据',
    action: payload.action || payload.suggestedAction || '按实时数据联动处理',
    sensors: { co, alcohol, voc, air: riskLevel === 'danger' ? 2 : riskLevel === 'warning' ? 1 : 0 },
    vision: { status: visionStatus, label: payload.vision?.label || payload.visionLabel || '未提供', confidence: Math.round((payload.vision?.confidence ?? payload.visionConfidence ?? 0) * 100) || 0 },
    actuators: { fan: payload.actuators?.fan || payload.fanStatus || 'off', fanPwmPercent: Number(payload.actuators?.fanPwmPercent ?? payload.fanPwmPercent ?? 0), fanDuty: Number(payload.actuators?.fanDuty ?? payload.fanDuty ?? 0), fanCommanded: Boolean(payload.actuators?.fanCommanded ?? payload.fanCommanded ?? false), fanPwmPin: payload.actuators?.fanPwmPin ?? payload.fanPwmPin ?? 4, fanPwmFreqHz: payload.actuators?.fanPwmFreqHz ?? payload.fanPwmFreqHz ?? 20000, fanTachRpm: payload.actuators?.fanTachRpm ?? payload.fanTachRpm, alarm: payload.actuators?.alarm || payload.alarmStatus || 'off', buzzer: payload.actuators?.buzzer || '未知', relay: payload.actuators?.relay || '未知' },
    device: { id: payload.deviceId || 'esp32-device', online: '在线', location: payload.location || '串口实时接入', power: payload.power || '--', wifi: payload.wifi || '--', uploadInterval: payload.uploadInterval || '实时' }
  };
}
function parseTelemetryLine(text) {
  const prefixIndex = text.indexOf(LABSAFE_TELEMETRY_PREFIX);
  const jsonText = prefixIndex >= 0 ? text.slice(prefixIndex + LABSAFE_TELEMETRY_PREFIX.length).trim() : text.trim();
  return JSON.parse(jsonText);
}
async function pollLocalBridge() {
  if (!state.bridge.enabled) return;
  try {
    const response = await fetch(state.bridge.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const bridgePayload = await response.json();
    if (!bridgePayload.ok || !bridgePayload.snapshot) throw new Error(bridgePayload.message || '暂无 ESP32-P4 数据');
    state.dataSource = 'external';
    state.bridge.connected = true;
    state.bridge.failureCount = 0;
    state.bridge.lastUpdatedAt = bridgePayload.updatedAt || bridgePayload.snapshot.receivedAt || null;
    state.bridge.message = '已接收 ESP32-P4 真实数据：' + (state.bridge.lastUpdatedAt || '刚刚');
    render(normalizeIncomingSnapshot(bridgePayload.snapshot));
    renderRealDeviceCard();
  } catch (error) {
    state.bridge.connected = false;
    state.bridge.failureCount += 1;
    state.bridge.message = state.bridge.failureCount <= 3
      ? '等待本地桥接服务：' + error.message
      : '未连接本地桥接，等待真实数据';
    if (state.dataSource !== 'external') state.dataSource = 'mock';
    renderRealDeviceCard();
  }
}
async function refreshSerialCandidates() {
  if (!state.serial.supported) {
    state.serial.message = '当前浏览器环境不支持 Web Serial';
    renderRealDeviceCard();
    return;
  }
  try {
    const ports = await navigator.serial.getPorts();
    state.serial.authorizedPorts = ports;
    state.serial.grantedPorts = ports.map(function (port, index) {
      const info = port.getInfo();
      return {
        label: '已授权串口 ' + (index + 1),
        note: 'VID_' + ((info.usbVendorId || 0).toString(16).toUpperCase()) + ' / PID_' + ((info.usbProductId || 0).toString(16).toUpperCase())
      };
    });
    if (!state.serial.connected && ports.length > 0) state.serial.portLabel = state.serial.grantedPorts[0].label + '（正在打开串口）';
    state.serial.message = ports.length ? '已检测到浏览器已授权串口 ' + ports.length + ' 个，正在自动打开读取' : '浏览器尚未授权任何串口';
    renderRealDeviceCard();
    if (!state.serial.connected && ports.length > 0) {
      connectSerialDevice();
      return;
    }
  } catch (error) {
    state.serial.message = '刷新串口候选失败：' + error.message;
  }
  renderRealDeviceCard();
}
async function readSerialStream(port) {
  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (state.serial.connected) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(function (line) {
        const text = line.trim();
        if (!text) return;
        state.serial.lastRawLine = text.slice(0, 180);
        try {
          const payload = parseTelemetryLine(text);
          state.dataSource = 'external';
          state.serial.message = '已收到 ESP32 实时数据：' + formatTime(new Date());
          state.serial.lastError = '';
          render(normalizeIncomingSnapshot(payload));
          renderRealDeviceCard();
        } catch (error) {
          state.serial.message = '串口已连接，但暂未收到 LABSAFE_JSON 数据。最近一行：' + state.serial.lastRawLine;
          renderRealDeviceCard();
        }
      });
    }
  } finally {
    reader.releaseLock();
  }
}
async function connectSerialDevice() {
  if (!state.serial.supported) {
    state.serial.message = '当前浏览器环境不支持 Web Serial';
    renderRealDeviceCard();
    return;
  }
  if (state.serial.connecting || state.serial.connected) {
    renderRealDeviceCard();
    return;
  }
  try {
    state.serial.connecting = true;
    state.serial.lastError = '';
    state.serial.message = '正在打开串口，请稍候。如果一直停在这里，可能端口被串口监视器或本地桥接占用。';
    renderRealDeviceCard();
    const authorizedPorts = await navigator.serial.getPorts();
    state.serial.authorizedPorts = authorizedPorts;
    const port = authorizedPorts[0] || await navigator.serial.requestPort();
    const info = port.getInfo();
    await port.open({ baudRate: 115200 });
    state.serial.port = port;
    state.serial.connected = true;
    state.serial.connecting = false;
    state.serial.portLabel = 'VID_' + ((info.usbVendorId || 0).toString(16).toUpperCase()) + ' / PID_' + ((info.usbProductId || 0).toString(16).toUpperCase());
    state.serial.message = '串口已连接，等待 ESP32 输出';
    renderRealDeviceCard();
    readSerialStream(port).catch(function (error) {
      state.serial.connected = false;
      state.serial.connecting = false;
      state.serial.lastError = error.message;
      state.serial.message = '串口读取中断：' + error.message;
      renderRealDeviceCard();
    });
  } catch (error) {
    state.serial.connecting = false;
    state.serial.connected = false;
    state.serial.lastError = error.message;
    state.serial.message = '连接串口失败：' + error.message;
    renderRealDeviceCard();
  }
}
function setupRealDeviceCard() {
  const connectButton = document.getElementById('serial-connect-button');
  const refreshButton = document.getElementById('serial-refresh-button');
  if (connectButton) connectButton.addEventListener('click', connectSerialDevice);
  if (refreshButton) refreshButton.addEventListener('click', refreshSerialCandidates);
  renderRealDeviceCard();
}
function getAvailableQueryRange(sensorKey) {
  const history = state.history[sensorKey] || [];
  if (history.length < 2) return 0;
  return Math.max(0, Math.round(history[history.length - 1].elapsedSeconds - history[0].elapsedSeconds));
}
function getSensorSampleInterval(sensorKey) {
  return Math.max(0.1, Number(state.sensorSampling[sensorKey] || 1));
}
function getHistoryLimit(sensorKey) {
  return 240;
}
function trimHistory(sensorKey) {
  const limit = getHistoryLimit(sensorKey);
  while (state.history[sensorKey].length > limit) state.history[sensorKey].shift();
}
function trimHistories() {
  ['co', 'alcohol', 'voc'].forEach(trimHistory);
}
function pushSensorHistory(sensorKey, value) {
  let elapsedSeconds;
  if (state.dataSource === 'mock') {
    const interval = getSensorSampleInterval(sensorKey);
    if (state.history[sensorKey].length > 0 && state.mockElapsedSeconds - state.sensorLastSampleAt[sensorKey] < interval) return;
    state.sensorLastSampleAt[sensorKey] = state.mockElapsedSeconds;
    elapsedSeconds = state.mockElapsedSeconds;
  } else {
    const last = state.history[sensorKey].at(-1);
    elapsedSeconds = last ? last.elapsedSeconds + getSensorSampleInterval(sensorKey) : 0;
  }
  state.history[sensorKey].push({
    id: sensorKey + '-' + state.sampleSequence[sensorKey]++,
    value: Number(value || 0),
    elapsedSeconds
  });
  trimHistory(sensorKey);
}
function pushHistory(snapshot) {
  if (state.dataSource !== 'external') return;
  pushSensorHistory('co', snapshot.sensors.co);
  pushSensorHistory('alcohol', snapshot.sensors.alcohol);
  pushSensorHistory('voc', snapshot.sensors.voc);
}
function getTrendMeta(canvasId) {
  const metaMap = {
    'trend-co': { key: 'co', name: 'CO', unit: 'ppm' },
    'trend-alcohol': { key: 'alcohol', name: '酒精', unit: 'ppm' },
    'trend-voc': { key: 'voc', name: 'VOC', unit: 'ppm' }
  };
  return metaMap[canvasId] || { key: '', name: '', unit: '' };
}
function getChartView(canvasId) {
  if (!chartViews[canvasId]) {
    chartViews[canvasId] = {
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      points: [],
      activePoint: null,
      activePointId: null,
      dragging: false,
      dragged: false,
      startX: 0,
      startY: 0,
      startOffsetX: 0,
      startOffsetY: 0
    };
  }
  return chartViews[canvasId];
}
function syncCanvasResolution(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(3, Math.max(window.devicePixelRatio || 1, 2.5));
  const width = Math.max(320, rect.width || 1200);
  const height = Math.max(260, rect.height || 430);
  const targetWidth = Math.round(width * dpr);
  const targetHeight = Math.round(height * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}
function getPlotArea(width, height) {
  const padding = { left: 98, right: 66, top: 56, bottom: 92 };
  return {
    left: padding.left,
    right: width - padding.right,
    top: padding.top,
    bottom: height - padding.bottom,
    width: width - padding.left - padding.right,
    height: height - padding.top - padding.bottom
  };
}
function getCanvasPointer(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}
function isInsidePlot(point, area) {
  return point.x >= area.left && point.x <= area.right && point.y >= area.top && point.y <= area.bottom;
}
function findNearestPoint(view, point) {
  let nearest = null;
  let nearestDistance = Infinity;
  view.points.forEach(function (item) {
    const distance = Math.hypot(item.x - point.x, item.y - point.y);
    if (distance < nearestDistance) {
      nearest = item;
      nearestDistance = distance;
    }
  });
  return nearestDistance <= 42 ? nearest : null;
}
function applyWheelZoom(event, canvas, view, options = {}) {
  if (!options.force && !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  event.stopPropagation();
  const point = getCanvasPointer(event, canvas);
  const factor = event.deltaY < 0 ? 1.22 : 0.82;
  view.scaleX = clamp(view.scaleX * factor, 0.12, 24);
  view.scaleY = clamp(view.scaleY * factor, 0.12, 24);
  view.offsetX += (point.x - canvas.getBoundingClientRect().width / 2) * (1 - factor) * 0.15;
  view.offsetY += (point.y - canvas.getBoundingClientRect().height / 2) * (1 - factor) * 0.15;
  renderTrends();
}
function resetChartView(canvasId) {
  const view = getChartView(canvasId);
  view.scaleX = 1;
  view.scaleY = 1;
  view.offsetX = 0;
  view.offsetY = 0;
  view.activePoint = null;
  view.activePointId = null;
  renderTrends();
}
function zoomChartByButton(canvasId, direction) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const view = getChartView(canvasId);
  const rect = canvas.getBoundingClientRect();
  const size = syncCanvasResolution(canvas);
  const area = getPlotArea(size.width, size.height);
  applyWheelZoom({
    ctrlKey: true,
    metaKey: false,
    deltaY: direction === 'in' ? -120 : 120,
    clientX: rect.left + area.left + area.width / 2,
    clientY: rect.top + area.top + area.height / 2,
    preventDefault: function () {},
    stopPropagation: function () {}
  }, canvas, view, { force: true });
}
function setupChartToolbar() {
  document.querySelectorAll('[data-chart-zoom]').forEach(function (button) {
    button.addEventListener('click', function () {
      const target = button.dataset.chartTarget;
      const action = button.dataset.chartZoom;
      if (action === 'reset') resetChartView(target);
      else zoomChartByButton(target, action);
    });
  });
}
function setupChartInteractions() {
  ['trend-co', 'trend-alcohol', 'trend-voc'].forEach(function (canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const view = getChartView(canvasId);

    canvas.addEventListener('pointerdown', function (event) {
      const point = getCanvasPointer(event, canvas);
      const size = syncCanvasResolution(canvas);
      const area = getPlotArea(size.width, size.height);
      if (!isInsidePlot(point, area)) return;
      view.dragging = true;
      view.dragged = false;
      view.startX = point.x;
      view.startY = point.y;
      view.startOffsetX = view.offsetX;
      view.startOffsetY = view.offsetY;
      canvas.classList.add('dragging');
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener('pointermove', function (event) {
      if (!view.dragging) return;
      const point = getCanvasPointer(event, canvas);
      const dx = point.x - view.startX;
      const dy = point.y - view.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) view.dragged = true;
      view.offsetX = view.startOffsetX + dx;
      view.offsetY = view.startOffsetY + dy;
      renderTrends();
    });

    canvas.addEventListener('pointerup', function (event) {
      const point = getCanvasPointer(event, canvas);
      if (!view.dragged) {
        const nearest = findNearestPoint(view, point);
        view.activePoint = nearest;
        view.activePointId = nearest ? nearest.id : null;
        renderTrends();
      }
      view.dragging = false;
      canvas.classList.remove('dragging');
      try { canvas.releasePointerCapture(event.pointerId); } catch (error) {}
    });

    canvas.addEventListener('pointerleave', function () {
      if (!view.dragging) return;
      view.dragging = false;
      canvas.classList.remove('dragging');
    });
    const wheelZoom = function (event) {
      applyWheelZoom(event, canvas, view);
    };
    canvas.addEventListener('wheel', wheelZoom, { passive: false });
    if (canvas.parentElement) {
      canvas.parentElement.addEventListener('wheel', wheelZoom, { passive: false });
    }

    canvas.addEventListener('dblclick', function () {
      view.scaleX = 1;
      view.scaleY = 1;
      view.offsetX = 0;
      view.offsetY = 0;
      view.activePoint = null;
      renderTrends();
    });
  });
}
function drawTooltip(ctx, point, area, meta) {
  const valueText = 'y=' + point.value + (meta.unit ? ' ' + meta.unit : '');
  const indexText = 'x=' + point.elapsedSeconds + 's · 点位 #' + (point.index + 1);
  ctx.save();
  ctx.font = '16px Microsoft YaHei, sans-serif';
  const width = Math.max(ctx.measureText(valueText).width, ctx.measureText(indexText).width) + 24;
  const height = 58;
  let x = point.x + 14;
  let y = point.y - height - 14;
  if (x + width > area.right) x = point.x - width - 14;
  if (y < area.top) y = point.y + 14;
  ctx.fillStyle = 'rgba(17, 24, 39, 0.92)';
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(valueText, x + 12, y + 24);
  ctx.fillStyle = '#d1d5db';
  ctx.fillText(indexText, x + 12, y + 46);
  ctx.restore();
}
function drawTrend(canvasId, values, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const size = syncCanvasResolution(canvas);
  const ctx = size.ctx;
  const width = size.width;
  const height = size.height;
  const area = getPlotArea(width, height);
  const numericValues = values.map(function (item) { return item.value; });
  const maxRaw = Math.max.apply(null, numericValues.concat([1]));
  const minRaw = Math.min.apply(null, numericValues.concat([0]));
  const max = Math.ceil(maxRaw / 10) * 10 || 10;
  const min = Math.max(0, Math.floor(minRaw / 10) * 10);
  const range = Math.max(max - min, 1);
  const meta = getTrendMeta(canvasId);
  const view = getChartView(canvasId);
  const sampleInterval = getSensorSampleInterval(meta.key);

  ctx.clearRect(0, 0, width, height);
  ctx.font = '16px Microsoft YaHei, sans-serif';
  ctx.lineWidth = 1;

  ctx.strokeStyle = '#e5e7eb';
  ctx.fillStyle = '#737373';
  for (let i = 0; i <= 4; i += 1) {
    const y = area.top + (area.height / 4) * i;
    const value = Math.round(max - (range / 4) * i);
    ctx.beginPath();
    ctx.moveTo(area.left, y);
    ctx.lineTo(area.right, y);
    ctx.stroke();
    ctx.fillText(String(value) + (meta.unit ? ' ' + meta.unit : ''), 12, y + 5);
  }

  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(area.left, area.top);
  ctx.lineTo(area.left, area.bottom);
  ctx.lineTo(area.right, area.bottom);
  ctx.stroke();

  view.points = [];
  if (values.length < 2) return;

  const originElapsedSeconds = values[0].elapsedSeconds;
  const latestElapsedSeconds = Math.max(0, values[values.length - 1].elapsedSeconds - originElapsedSeconds);

  ctx.fillStyle = '#737373';
  ctx.fillText(meta.unit, 8, 24);
  ctx.fillText('时间 / 秒', width - 92, height - 12);
  for (let i = 0; i <= 4; i += 1) {
    const x = area.left + (area.width / 4) * i;
    const elapsedSeconds = Math.round((latestElapsedSeconds / 4) * i);
    const label = elapsedSeconds + 's';
    ctx.fillText(label, i === 0 ? x : x - 14, height - 46);
  }
  ctx.fillText('起始', area.left, height - 16);
  ctx.fillText('当前', area.right - 108, height - 16);

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.left, area.top, area.width, area.height);
  ctx.clip();

  ctx.strokeStyle = color;
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  values.forEach(function (sample, index) {
    const elapsedSeconds = Math.max(0, sample.elapsedSeconds - originElapsedSeconds);
    const normalizedX = latestElapsedSeconds === 0 ? 0 : (elapsedSeconds / latestElapsedSeconds);
    const baseX = area.left + normalizedX * area.width;
    const baseY = area.top + area.height - ((sample.value - min) / range) * area.height;
    const x = area.left + (baseX - area.left) * view.scaleX + view.offsetX;
    const y = area.top + (baseY - area.top) * view.scaleY + view.offsetY;
    view.points.push({ id: sample.id, x, y, value: sample.value, index, elapsedSeconds });
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  view.points.forEach(function (point) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
  if (view.activePointId) {
    const updatedPoint = view.points.find(function (point) { return point.id === view.activePointId; });
    view.activePoint = updatedPoint || null;
    if (!updatedPoint) view.activePointId = null;
  }
  const activePoint = view.activePoint;
  if (activePoint) {
    ctx.strokeStyle = 'rgba(17, 24, 39, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(activePoint.x, area.top);
    ctx.lineTo(activePoint.x, area.bottom);
    ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(activePoint.x, activePoint.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
  if (activePoint) drawTooltip(ctx, activePoint, area, meta);
}
function renderTrends() {
  drawTrend('trend-co', state.history.co, '#2563eb');
  drawTrend('trend-alcohol', state.history.alcohol, '#e1306c');
  drawTrend('trend-voc', state.history.voc, '#16a34a');
  applyChartMode();
  renderChartDebugInfo();
}
function renderChartDebugInfo() {
  ['trend-co', 'trend-alcohol', 'trend-voc'].forEach(function (canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !canvas.parentElement) return;
    const view = getChartView(canvasId);
    canvas.parentElement.dataset.zoom = '缩放 ' + view.scaleX.toFixed(2) + 'x';
  });
}
function maybeCreateAlarm(snapshot) {
  if (snapshot.riskLevel === 'normal') return;
  state.alarms.unshift({ time: snapshot.timestamp, source: snapshot.reason.includes('视觉') ? '视觉识别 / 传感器' : '气体传感器', level: levelText(snapshot.riskLevel), levelKey: snapshot.riskLevel, reason: snapshot.reason, status: '未确认' });
  if (state.alarms.length > 8) state.alarms.pop();
}
function renderAlarms() {
  const body = document.getElementById('alarm-table-body');
  body.innerHTML = '';
  if (state.alarms.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="5" class="muted">暂无报警事件。</td>';
    body.appendChild(row);
  } else {
    state.alarms.forEach(function (alarm) {
      const row = document.createElement('tr');
      row.innerHTML = '<td>' + alarm.time + '</td><td>' + alarm.source + '</td><td><span class="risk-pill risk-' + alarm.levelKey + '">' + alarm.level + '</span></td><td>' + alarm.reason + '</td><td>' + alarm.status + '</td>';
      body.appendChild(row);
    });
  }
  const pending = state.alarms.filter(function (alarm) { return alarm.status === '未确认'; }).length;
  setText('pending-count', String(pending));
  setText('nav-alert-count', String(pending));
}
function pushEvent(snapshot) {
  state.events.unshift({ time: snapshot.timestamp, title: snapshot.riskLevel === 'normal' ? '数据刷新' : '风险事件触发', desc: snapshot.reason, level: snapshot.riskLevel });
  if (state.events.length > 10) state.events.pop();
}
function renderEvents() {
  const stream = document.getElementById('event-stream');
  stream.innerHTML = '';
  state.events.forEach(function (event) {
    const item = document.createElement('article');
    item.className = 'event-item';
    item.innerHTML = '<strong>' + event.title + '</strong><span>' + event.desc + '</span><small>' + event.time + '</small>';
    stream.appendChild(item);
  });
}
function normalizeHistory(sensorKey) {
  return (state.history[sensorKey] || []).map(function (sample, index) {
    if (sample && typeof sample === 'object' && 'value' in sample) return sample;
    return {
      id: sensorKey + '-legacy-' + index,
      value: Number(sample || 0),
      elapsedSeconds: index * getSensorSampleInterval(sensorKey)
    };
  });
}
function buildMergedRows() {
  const histories = {
    co: normalizeHistory('co'),
    alcohol: normalizeHistory('alcohol'),
    voc: normalizeHistory('voc')
  };
  const rowCount = Math.max(histories.co.length, histories.alcohol.length, histories.voc.length, 0);
  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    const co = histories.co[index] || null;
    const alcohol = histories.alcohol[index] || null;
    const voc = histories.voc[index] || null;
    rows.push({
      sample_id: 'sample-' + index,
      elapsed_seconds: co?.elapsedSeconds ?? alcohol?.elapsedSeconds ?? voc?.elapsedSeconds ?? index,
      co_ppm: co?.value ?? null,
      alcohol_ppm: alcohol?.value ?? null,
      voc_ppm: voc?.value ?? null,
      risk_level: state.current?.riskLevel || 'normal'
    });
  }
  return rows;
}
function buildResearchWideRows() {
  return buildMergedRows();
}
function buildResearchLongRows() {
  const rows = [];
  ['co', 'alcohol', 'voc'].forEach(function (sensorKey) {
    normalizeHistory(sensorKey).forEach(function (sample, index) {
      rows.push({
        sample_id: sensorKey + '-' + index,
        sensor_type: sensorKey,
        elapsed_seconds: sample.elapsedSeconds,
        value_ppm: sample.value,
        unit: 'ppm'
      });
    });
  });
  return rows;
}
function buildTrainingSnapshotRows() {
  return buildMergedRows().map(function (row) {
    return {
      sample_id: row.sample_id,
      elapsed_seconds: row.elapsed_seconds,
      co_ppm: row.co_ppm,
      alcohol_ppm: row.alcohol_ppm,
      voc_ppm: row.voc_ppm,
      label_risk: row.risk_level,
      label_alarm: row.risk_level === 'normal' ? 0 : 1
    };
  });
}
function buildSensorWindowRows(sensorKey) {
  const labelMap = { co: 'CO', alcohol: '酒精气体', voc: 'VOC' };
  return normalizeHistory(sensorKey).map(function (sample, index) {
    return {
      sample_id: sensorKey + '-' + index,
      sensor_type: sensorKey,
      sensor_name: labelMap[sensorKey] || sensorKey,
      elapsed_seconds: sample.elapsedSeconds,
      value_ppm: sample.value,
      unit: 'ppm'
    };
  });
}
function buildAlarmEventRows() {
  return state.alarms.map(function (alarm, index) {
    return {
      event_id: 'alarm-' + index,
      event_time: alarm.time,
      source: alarm.source,
      level: alarm.level,
      reason: alarm.reason,
      status: alarm.status
    };
  });
}
function getExportTimeRange() {
  const startInput = document.getElementById('export-start-seconds');
  const endInput = document.getElementById('export-end-seconds');
  const rawStart = startInput ? startInput.value.trim() : '';
  const rawEnd = endInput ? endInput.value.trim() : '';
  const startSeconds = rawStart === '' ? 0 : Number(rawStart);
  const endSeconds = rawEnd === '' ? Infinity : Number(rawEnd);
  if (!Number.isFinite(startSeconds) || startSeconds < 0) {
    return { valid: false, message: '导出起始时间必须是不小于 0 的数字' };
  }
  if (rawEnd !== '' && (!Number.isFinite(endSeconds) || endSeconds < 0)) {
    return { valid: false, message: '导出终止时间必须是不小于 0 的数字' };
  }
  if (endSeconds < startSeconds) {
    return { valid: false, message: '导出终止时间不能小于起始时间' };
  }
  return { valid: true, startSeconds, endSeconds, hasEnd: rawEnd !== '' };
}
function filterRowsByExportRange(rows, range) {
  const hasElapsedRows = rows.some(function (row) {
    return row && typeof row.elapsed_seconds !== 'undefined' && row.elapsed_seconds !== null;
  });
  if (!hasElapsedRows) return { rows, applied: false };
  return {
    rows: rows.filter(function (row) {
      const elapsedSeconds = Number(row.elapsed_seconds);
      if (!Number.isFinite(elapsedSeconds)) return false;
      return elapsedSeconds >= range.startSeconds && elapsedSeconds <= range.endSeconds;
    }),
    applied: true
  };
}
function serializeCsv(rows) {
  if (!rows.length) return 'no_data\n';
  const headers = Object.keys(rows[0]);
  const escapeCell = function (value) {
    if (value === null || typeof value === 'undefined') return '';
    const text = String(value).replace(/"/g, '""');
    return /[",\n]/.test(text) ? '"' + text + '"' : text;
  };
  return [headers.join(',')].concat(rows.map(function (row) {
    return headers.map(function (header) { return escapeCell(row[header]); }).join(',');
  })).join('\n');
}
function downloadExportFile(filename, content, mimeType) {
  const blob = new Blob(['\uFEFF' + content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 0);
}
function exportData() {
  const format = document.getElementById('export-format')?.value || 'csv';
  const preset = document.getElementById('export-preset')?.value || 'sensor_co';
  const presetBuilders = {
    sensor_co: { name: 'co-window', label: 'CO 数据窗口', rows: function () { return buildSensorWindowRows('co'); } },
    sensor_alcohol: { name: 'alcohol-window', label: '酒精气体数据窗口', rows: function () { return buildSensorWindowRows('alcohol'); } },
    sensor_voc: { name: 'voc-window', label: 'VOC 数据窗口', rows: function () { return buildSensorWindowRows('voc'); } }
  };
  const selected = presetBuilders[preset] || presetBuilders.sensor_co;
  const range = getExportTimeRange();
  if (!range.valid) {
    setText('export-status', range.message);
    return;
  }
  const originalRows = selected.rows();
  const filtered = filterRowsByExportRange(originalRows, range);
  const rows = filtered.rows;
  if (!rows.length) {
    setText('export-status', filtered.applied ? '当前时间范围内暂无可导出的数据' : '暂无可导出的数据');
    return;
  }
  const rangeLabel = filtered.applied ? ('，范围 ' + range.startSeconds + 's 到 ' + (range.hasEnd ? range.endSeconds + 's' : '当前最大时刻')) : '';
  const filename = 'labsafe-' + selected.name + '-' + Date.now() + '.' + format;
  if (format === 'json') {
    downloadExportFile(filename, JSON.stringify({ preset, exported_at: new Date().toISOString(), export_range_seconds: filtered.applied ? { start: range.startSeconds, end: range.hasEnd ? range.endSeconds : null } : null, rows }, null, 2), 'application/json;charset=utf-8;');
  } else {
    downloadExportFile(filename, serializeCsv(rows), 'text/csv;charset=utf-8;');
  }
  setText('export-status', '已导出 ' + rows.length + ' 条' + selected.label + '数据（' + format.toUpperCase() + rangeLabel + '）');
}
function renderSnapshot(snapshot) { window.__LABSAFE_CURRENT_SNAPSHOT__ = snapshot; }
function render(snapshot) {
  state.current = snapshot;
  renderSummary(snapshot);
  renderSensors(snapshot);
  renderVision(snapshot);
  renderActuators(snapshot);
  renderDevice(snapshot);
  pushHistory(snapshot);
  renderTrends();
  maybeCreateAlarm(snapshot);
  renderAlarms();
  pushEvent(snapshot);
  renderEvents();
  renderSnapshot(snapshot);
}
function tick() {
  if (state.dataSource !== 'external') return;
  state.mockElapsedSeconds += 1;
}

window.LabSafeDataBridge = {
  setDataSource: function (source) {
    state.dataSource = source || 'mock';
  },
  setTimeWindow: function (seconds) {
    state.query.elapsedSeconds = Math.max(0, Number(seconds || 0));
    const input = document.getElementById('query-time-seconds');
    if (input) input.value = String(state.query.elapsedSeconds);
  },
  setSensorWindow: function (sensorKey, seconds) {
    state.query.sensorType = sensorKey;
    state.query.elapsedSeconds = Math.max(0, Number(seconds || 0));
    const typeInput = document.getElementById('query-sensor-type');
    const timeInput = document.getElementById('query-time-seconds');
    if (typeInput) typeInput.value = sensorKey;
    if (timeInput) timeInput.value = String(state.query.elapsedSeconds);
  },
  setSensorSampling: function (sensorKey, seconds) {
    if (!state.sensorSampling[sensorKey]) return;
    state.sensorSampling[sensorKey] = Math.max(0.1, Number(seconds || 1));
    trimHistory(sensorKey);
    renderTrends();
  },
  pushSensorSample: function (sensorKey, value) {
    if (!state.history[sensorKey]) return;
    state.dataSource = 'external';
    pushSensorHistory(sensorKey, value);
    renderTrends();
  },
  ingestSnapshot: function (snapshot) {
    state.dataSource = 'external';
    render(snapshot);
  },
  getState: function () {
    return state;
  }
};

setupAuth();
setupNavigation();
setupAccountAdmin();
setupChartModeSelector();
setupRealDeviceCard();
renderBoardDetectionStatus();
setupChartToolbar();
setupChartInteractions();
window.addEventListener('load', function () {
  renderChartDebugInfo();
  renderBoardDetectionStatus();
  refreshSerialCandidates();
});
render(buildWaitingSnapshot());
setInterval(tick, 1000);
pollLocalBridge();
setInterval(pollLocalBridge, 1000);





