import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const htmlPath = path.join(root, 'index.html');
const cssPath = path.join(root, 'assets', 'styles.css');
const jsPath = path.join(root, 'assets', 'app.js');

let html = fs.readFileSync(htmlPath, 'utf8');

const perSensorWindowBlock = `
              <div class="time-window-setting sensor-window-setting">
                <span class="config-label">各传感器 X 轴窗口</span>
                <div class="sensor-window-grid">
                  <label>CO <span><input class="sensor-window-input" type="number" min="6" max="3600" step="3" value="72" data-sensor-window="co" /> 秒</span></label>
                  <label>酒精 <span><input class="sensor-window-input" type="number" min="6" max="3600" step="3" value="72" data-sensor-window="alcohol" /> 秒</span></label>
                  <label>VOC <span><input class="sensor-window-input" type="number" min="6" max="3600" step="3" value="72" data-sensor-window="voc" /> 秒</span></label>
                </div>
              </div>`;

html = html.replace(/\s*<div class="time-window-setting">\s*<span class="config-label">[\s\S]*?<input id="time-window-input"[\s\S]*?<\/div>\s*<\/div>/, perSensorWindowBlock);
fs.writeFileSync(htmlPath, html, 'utf8');

let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('Per-sensor time window controls')) {
  css += `

/* Per-sensor time window controls */
.sensor-window-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.sensor-window-grid label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 10px 12px;
  background: #fff;
  gap: 10px;
  font-weight: 900;
}

.sensor-window-grid span {
  display: inline-flex;
  align-items: center;
  color: var(--muted);
  gap: 6px;
  white-space: nowrap;
}

.sensor-window-input {
  width: 78px;
  border: 0;
  outline: 0;
  border-radius: 10px;
  padding: 6px 8px;
  background: #f7f7f7;
  color: var(--text);
  font-weight: 900;
}

@media (max-width: 860px) {
  .sensor-window-grid {
    grid-template-columns: 1fr;
  }
}
`;
}
fs.writeFileSync(cssPath, css, 'utf8');

let js = fs.readFileSync(jsPath, 'utf8');
js = js.replace(
  /const state = [^\n]+;/,
  "const state = { history: { co: [], alcohol: [], voc: [] }, alarms: [], events: [], current: null, account: null, chartTypes: ['co', 'alcohol', 'voc'], sensorWindows: { co: 72, alcohol: 72, voc: 72 }, sensorSampling: { co: 3, alcohol: 3, voc: 3 }, sensorLastSampleAt: { co: -Infinity, alcohol: -Infinity, voc: -Infinity }, mockElapsedSeconds: 0, dataSource: 'mock' };"
);

js = js.replace(/function setupChartModeSelector\(\) \{[\s\S]*?\n\}\nfunction applyChartMode\(\) \{[\s\S]*?\n\}\n\nfunction renderSummary/, `function setupChartModeSelector() {
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

  document.querySelectorAll('.sensor-window-input').forEach(function (input) {
    const sensorKey = input.dataset.sensorWindow;
    input.value = String(getSensorWindow(sensorKey));
    input.addEventListener('change', function () {
      setSensorWindow(sensorKey, Number(input.value || getSensorWindow(sensorKey)));
      input.value = String(getSensorWindow(sensorKey));
    });
  });

  applyChartMode();
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

function renderSummary`);

js = js.replace(/function getSensorSampleInterval\(sensorKey\) \{[\s\S]*?\n\}\nfunction getHistoryLimit\(sensorKey\) \{[\s\S]*?\n\}\nfunction trimHistories\(\) \{[\s\S]*?\n\}\nfunction pushHistory\(snapshot\) \{[\s\S]*?\n\}\nfunction getTrendMeta/, `function getSensorWindow(sensorKey) {
  return Math.max(6, Number(state.sensorWindows[sensorKey] || 72));
}
function deriveSamplingInterval(sensorKey) {
  return Math.max(1, Math.round(getSensorWindow(sensorKey) / 24));
}
function setSensorWindow(sensorKey, seconds) {
  if (!state.sensorWindows[sensorKey]) return;
  state.sensorWindows[sensorKey] = clamp(Number(seconds || 72), 6, 3600);
  state.sensorSampling[sensorKey] = deriveSamplingInterval(sensorKey);
  trimHistory(sensorKey);
  applyChartMode();
  renderTrends();
}
function getSensorSampleInterval(sensorKey) {
  return Math.max(0.1, Number(state.sensorSampling[sensorKey] || deriveSamplingInterval(sensorKey)));
}
function getHistoryLimit(sensorKey) {
  return Math.max(2, Math.ceil(getSensorWindow(sensorKey) / getSensorSampleInterval(sensorKey)) + 1);
}
function trimHistory(sensorKey) {
  const limit = getHistoryLimit(sensorKey);
  while (state.history[sensorKey].length > limit) state.history[sensorKey].shift();
}
function trimHistories() {
  ['co', 'alcohol', 'voc'].forEach(trimHistory);
}
function pushSensorHistory(sensorKey, value) {
  if (state.dataSource === 'mock') {
    const interval = getSensorSampleInterval(sensorKey);
    if (state.history[sensorKey].length > 0 && state.mockElapsedSeconds - state.sensorLastSampleAt[sensorKey] < interval) return;
    state.sensorLastSampleAt[sensorKey] = state.mockElapsedSeconds;
  }
  state.history[sensorKey].push(Number(value || 0));
  trimHistory(sensorKey);
}
function pushHistory(snapshot) {
  pushSensorHistory('co', snapshot.sensors.co);
  pushSensorHistory('alcohol', snapshot.sensors.alcohol);
  pushSensorHistory('voc', snapshot.sensors.voc);
}
function getTrendMeta`);

js = js.replace(/const secondsAgo = Math\.round\(state\.timeWindowSeconds - \(state\.timeWindowSeconds \/ 4\) \* i\);/, "const secondsAgo = Math.round(getSensorWindow(meta.key) - (getSensorWindow(meta.key) / 4) * i);");
js = js.replace(/const baseX = area\.right - \(secondsAgo \/ state\.timeWindowSeconds\) \* area\.width;/, "const baseX = area.right - (secondsAgo / getSensorWindow(meta.key)) * area.width;");
js = js.replace(/const secondsAgo = Math\.max\(0, \(state\.history\.co\.length - 1 - point\.index\) \* 3\);\n  const indexText = 'x=-' \+ secondsAgo \+ 's · 点位 #' \+ \(point\.index \+ 1\);/, "const indexText = 'x=-' + point.secondsAgo + 's · 点位 #' + (point.index + 1);");

js = js.replace(/function tick\(\) \{ if \(state\.dataSource === 'mock'\) render\(buildSnapshot\(\)\); \}/, "function tick() { if (state.dataSource === 'mock') { state.mockElapsedSeconds += 3; render(buildSnapshot()); } }");

js = js.replace(/setTimeWindow: function \(seconds\) \{[\s\S]*?\n  \},\n  setSensorSampling/, `setTimeWindow: function (seconds) {
    ['co', 'alcohol', 'voc'].forEach(function (key) { setSensorWindow(key, seconds); });
    document.querySelectorAll('.sensor-window-input').forEach(function (input) {
      input.value = String(getSensorWindow(input.dataset.sensorWindow));
    });
  },
  setSensorWindow: function (sensorKey, seconds) {
    setSensorWindow(sensorKey, seconds);
    const input = document.querySelector('[data-sensor-window="' + sensorKey + '"]');
    if (input) input.value = String(getSensorWindow(sensorKey));
  },
  setSensorSampling`);

js = js.replace(/setSensorSampling: function \(sensorKey, seconds\) \{[\s\S]*?\n  \},\n  pushSensorSample/, `setSensorSampling: function (sensorKey, seconds) {
    if (!state.sensorSampling[sensorKey]) return;
    state.sensorSampling[sensorKey] = Math.max(0.1, Number(seconds || deriveSamplingInterval(sensorKey)));
    trimHistory(sensorKey);
    renderTrends();
  },
  pushSensorSample`);

js = js.replace(/pushSensorSample: function \(sensorKey, value\) \{[\s\S]*?\n  \},\n  ingestSnapshot/, `pushSensorSample: function (sensorKey, value) {
    if (!state.history[sensorKey]) return;
    state.dataSource = 'external';
    state.history[sensorKey].push(Number(value || 0));
    trimHistory(sensorKey);
    renderTrends();
  },
  ingestSnapshot`);

fs.writeFileSync(jsPath, js, 'utf8');
console.log('已改为每个传感器独立时间窗口，并让窗口影响模拟采样更新速率。');
