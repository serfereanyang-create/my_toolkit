import fs from 'node:fs';
import path from 'node:path';

const cssPath = path.join('D:\\codex', '嵌赛app', 'assets', 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');

if (!css.includes('Center and widen chart mode settings')) {
  css += `

/* Center and widen chart mode settings */
.chart-config {
  grid-template-columns: 1fr !important;
}

.sensor-window-setting {
  width: min(920px, 100%);
  margin: 0 auto;
}

.sensor-window-setting .config-label {
  text-align: center;
}

.sensor-window-grid {
  grid-template-columns: repeat(3, minmax(180px, 1fr)) !important;
  justify-content: center;
  max-width: 860px;
  margin: 0 auto;
}

.sensor-window-grid label {
  justify-content: center !important;
  min-height: 72px;
  padding: 12px 18px !important;
  gap: 14px !important;
}

.sensor-window-grid label > span {
  flex: 0 0 auto;
}

.sensor-window-input {
  width: 84px !important;
  text-align: center;
}
`;
}

fs.writeFileSync(cssPath, css, 'utf8');
console.log('已把传感器时间窗口控件居中并加宽。');
