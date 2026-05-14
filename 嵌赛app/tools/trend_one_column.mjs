import fs from 'node:fs';
import path from 'node:path';

const cssPath = path.join('D:\\codex', '嵌赛app', 'assets', 'styles.css');
let css = fs.readFileSync(cssPath, 'utf8');

if (!css.includes('Trend charts: one card per row')) {
  css += `

/* Trend charts: one card per row for better horizontal space */
.trend-grid,
.trend-card .trend-grid {
  grid-template-columns: 1fr !important;
}

.trend-grid > div {
  width: 100%;
  min-height: 430px;
}

.trend-grid canvas,
.trend-grid.single canvas {
  height: 340px;
}

.trend-grid.single > div {
  min-height: 430px;
}
`;
}

fs.writeFileSync(cssPath, css, 'utf8');
console.log('已改为每个趋势图单独一行卡片。');
