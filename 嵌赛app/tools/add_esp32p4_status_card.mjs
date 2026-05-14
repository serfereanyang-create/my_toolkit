import fs from 'node:fs';
import path from 'node:path';

const root = 'D:/codex/嵌赛app';
const indexPath = path.join(root, 'index.html');
const appPath = path.join(root, 'assets', 'app.js');
const cssPath = path.join(root, 'assets', 'styles.css');

let html = fs.readFileSync(indexPath, 'utf8');
if (!html.includes('esp32p4-status-card')) {
  html = html.replace(
    '<section class="card section-card">\n            <div class="section-head">\n              <div>\n                <p class="eyebrow">Raw Data</p>',
    `<section class="card section-card esp32p4-status-card">\n            <div class="section-head compact">\n              <div>\n                <p class="eyebrow">ESP32-P4</p>\n                <h2>ESP32-P4 识别状态</h2>\n              </div>\n              <span id="esp32p4-chip" class="status-chip">待扫描</span>\n            </div>\n            <div class="esp32p4-grid">\n              <article class="esp32p4-stat">\n                <span>识别结果</span>\n                <strong id="esp32p4-detected">未检测</strong>\n                <p id="esp32p4-message">等待本地设备扫描</p>\n              </article>\n              <article class="esp32p4-stat">\n                <span>推荐串口</span>\n                <strong id="esp32p4-port">未提供</strong>\n                <p id="esp32p4-count">候选数：0</p>\n              </article>\n            </div>\n          </section>\n\n          <section class="card section-card">\n            <div class="section-head">\n              <div>\n                <p class="eyebrow">Raw Data</p>`
  );
}
if (!html.includes('data/device-scan.js')) {
  html = html.replace('<script src="assets/app.js"></script>', '<script src="data/device-scan.js"></script>\n    <script src="assets/app.js"></script>');
}
fs.writeFileSync(indexPath, html, 'utf8');

let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('.esp32p4-grid')) {
  css += `

.esp32p4-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.esp32p4-stat {
  border: 1px solid var(--soft-line);
  border-radius: 20px;
  padding: 18px;
  background: #fff;
}

.esp32p4-stat span {
  color: var(--muted);
}

.esp32p4-stat strong {
  display: block;
  margin: 10px 0 8px;
  font-size: 28px;
}

.esp32p4-stat p {
  margin: 0;
  color: var(--muted);
  line-height: 1.7;
}

@media (max-width: 860px) {
  .esp32p4-grid {
    grid-template-columns: 1fr;
  }
}
`;
}
fs.writeFileSync(cssPath, css, 'utf8');

let js = fs.readFileSync(appPath, 'utf8');
if (!js.includes('renderEsp32P4Status')) {
  js = js.replace(
    "function renderRealDeviceCard() {",
    `function renderEsp32P4Status() {\n  const scan = window.__LABSAFE_DEVICE_SCAN__;\n  if (!scan) {\n    setText('esp32p4-chip', '无扫描结果');\n    setText('esp32p4-detected', '未检测');\n    setText('esp32p4-message', '尚未加载本地扫描结果');\n    setText('esp32p4-port', '未提供');\n    setText('esp32p4-count', '候选数：0');\n    return;\n  }\n  const preferred = (scan.devices || []).filter(function (device) { return device.isEsp32P4; });\n  const firstPort = preferred.find(function (device) { return device.com; }) || null;\n  setText('esp32p4-chip', scan.esp32p4Detected ? '已识别 ESP32-P4' : '未识别 ESP32-P4');\n  setText('esp32p4-detected', scan.esp32p4Detected ? '已检测' : '未检测');\n  setText('esp32p4-message', scan.esp32p4Detected ? '本地扫描已发现符合 ESP32-P4 特征的设备' : '当前未发现明确的 ESP32-P4 设备');\n  setText('esp32p4-port', firstPort ? firstPort.com : '未提供');\n  setText('esp32p4-count', '候选数：' + preferred.length);\n}\nfunction renderRealDeviceCard() {`
  );

  js = js.replace(
    "setupRealDeviceCard();\nsetupChartToolbar();",
    "setupRealDeviceCard();\nrenderEsp32P4Status();\nsetupChartToolbar();"
  );

  js = js.replace(
    "window.addEventListener('load', function () {\n  renderChartDebugInfo();\n  refreshSerialCandidates();\n});",
    "window.addEventListener('load', function () {\n  renderChartDebugInfo();\n  renderEsp32P4Status();\n  refreshSerialCandidates();\n});"
  );
}
fs.writeFileSync(appPath, js, 'utf8');

console.log('已接入本地扫描结果，并在数据窗口新增 ESP32-P4 状态卡片。');
