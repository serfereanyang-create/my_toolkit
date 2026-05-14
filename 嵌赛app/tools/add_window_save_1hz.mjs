import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const htmlPath = path.join(root, 'index.html');
const cssPath = path.join(root, 'assets', 'styles.css');
const jsPath = path.join(root, 'assets', 'app.js');

let html = fs.readFileSync(htmlPath, 'utf8');
if (!html.includes('save-window-settings')) {
  html = html.replace(
    /(<\/div>\s*<\/div>\s*<\/div>\s*<\/section>)/,
    `</div>
                <div class="window-setting-actions">
                  <button id="save-window-settings" class="window-save-button" type="button">保存窗口设置</button>
                  <span id="window-save-status" class="window-save-status">默认采样：1Hz</span>
                </div>
              </div>
            </div>
          </section>`
  );
}
fs.writeFileSync(htmlPath, html, 'utf8');

let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('.window-setting-actions')) {
  css += `

.window-setting-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 14px;
}

.window-save-button {
  border: 0;
  border-radius: 999px;
  padding: 10px 18px;
  color: #fff;
  background: linear-gradient(135deg, var(--purple), var(--pink), var(--orange));
  cursor: pointer;
  font-weight: 900;
}

.window-save-status {
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
}
`;
}
fs.writeFileSync(cssPath, css, 'utf8');

let js = fs.readFileSync(jsPath, 'utf8');

js = js.replace(
  /const state = [^\n]+;/,
  "const state = { history: { co: [], alcohol: [], voc: [] }, alarms: [], events: [], current: null, account: null, chartTypes: ['co', 'alcohol', 'voc'], sensorWindows: { co: 72, alcohol: 72, voc: 72 }, sensorSampling: { co: 1, alcohol: 1, voc: 1 }, sensorLastSampleAt: { co: -Infinity, alcohol: -Infinity, voc: -Infinity }, mockElapsedSeconds: 0, dataSource: 'mock' };"
);

js = js.replace(
  /  document\.querySelectorAll\('\.sensor-window-input'\)\.forEach\(function \(input\) \{[\s\S]*?\n  \}\);\n\n  applyChartMode\(\);\n\}/,
  `  document.querySelectorAll('.sensor-window-input').forEach(function (input) {
    const sensorKey = input.dataset.sensorWindow;
    input.value = String(getSensorWindow(sensorKey));
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') saveSensorWindowSettings();
    });
  });

  const saveButton = document.getElementById('save-window-settings');
  if (saveButton) saveButton.addEventListener('click', saveSensorWindowSettings);

  applyChartMode();
}
function saveSensorWindowSettings() {
  let changed = false;
  document.querySelectorAll('.sensor-window-input').forEach(function (input) {
    const sensorKey = input.dataset.sensorWindow;
    const previous = getSensorWindow(sensorKey);
    const next = clamp(Number(input.value || previous), 6, 3600);
    input.value = String(next);
    if (previous !== next) {
      state.sensorWindows[sensorKey] = next;
      trimHistory(sensorKey);
      changed = true;
    }
  });
  applyChartMode();
  renderTrends();
  setText('window-save-status', changed ? '已保存，X 轴窗口已更新' : '设置未变化 · 默认采样 1Hz');
}`
);

js = js.replace(
  /function deriveSamplingInterval\(sensorKey\) \{\n  return Math\.max\(1, Math\.round\(getSensorWindow\(sensorKey\) \/ 24\)\);\n\}/,
  `function deriveSamplingInterval(sensorKey) {
  return 1;
}`
);

js = js.replace(
  /function setSensorWindow\(sensorKey, seconds\) \{[\s\S]*?\n\}/,
  `function setSensorWindow(sensorKey, seconds) {
  if (!state.sensorWindows[sensorKey]) return;
  state.sensorWindows[sensorKey] = clamp(Number(seconds || 72), 6, 3600);
  trimHistory(sensorKey);
  applyChartMode();
  renderTrends();
}`
);

js = js.replace(
  /function getSensorSampleInterval\(sensorKey\) \{\n  return Math\.max\(0\.1, Number\(state\.sensorSampling\[sensorKey\] \|\| deriveSamplingInterval\(sensorKey\)\)\);\n\}/,
  `function getSensorSampleInterval(sensorKey) {
  return Math.max(0.1, Number(state.sensorSampling[sensorKey] || 1));
}`
);

js = js.replace(
  /function tick\(\) \{ if \(state\.dataSource === 'mock'\) \{ state\.mockElapsedSeconds \+= 3; render\(buildSnapshot\(\)\); \} \}/,
  `function tick() { if (state.dataSource === 'mock') { state.mockElapsedSeconds += 1; render(buildSnapshot()); } }`
);

js = js.replace('setInterval(tick, 3000);', 'setInterval(tick, 1000);');

fs.writeFileSync(jsPath, js, 'utf8');
console.log('已添加保存按钮，并把默认模拟采样改为 1Hz。');
