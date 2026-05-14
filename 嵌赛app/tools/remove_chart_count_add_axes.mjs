import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const htmlPath = path.join(root, 'index.html');
const cssPath = path.join(root, 'assets', 'styles.css');
const jsPath = path.join(root, 'assets', 'app.js');

let html = fs.readFileSync(htmlPath, 'utf8');

html = html.replace(/\s*<div>\s*<span class="config-label">渲染数目<\/span>[\s\S]*?<select id="chart-count-select"[\s\S]*?<\/select>\s*<\/div>/, '');
html = html.replace('              <span id="chart-mode-desc">当前显示：全部曲线</span>', '              <span id="chart-mode-desc">当前显示：CO / 酒精 / VOC</span>');

fs.writeFileSync(htmlPath, html, 'utf8');

let css = fs.readFileSync(cssPath, 'utf8');
css = css.replace(/\n\.chart-count-select \{[\s\S]*?\n\}\n/, '\n');
css = css.replace(/\.chart-config \{[\s\S]*?\n\}/, `.chart-config {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
}`);
if (!css.includes('.chart-axis-note')) {
  css += `

.chart-axis-note {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
}
`;
}

fs.writeFileSync(cssPath, css, 'utf8');

let js = fs.readFileSync(jsPath, 'utf8');

js = js.replace(
  /const state = \{ history: \{ co: \[\], alcohol: \[\], voc: \[\] \}, alarms: \[\], events: \[\], current: null, account: null, chartTypes: \['co', 'alcohol', 'voc'\], chartCount: 3 \};/,
  "const state = { history: { co: [], alcohol: [], voc: [] }, alarms: [], events: [], current: null, account: null, chartTypes: ['co', 'alcohol', 'voc'] };"
);

js = js.replace(/\n\s*const countSelect = document\.getElementById\('chart-count-select'\);[\s\S]*?countSelect\.addEventListener\('change',[\s\S]*?\n\s*\}\);\n/, '\n');

js = js.replace(
  /function applyChartMode\(\) \{[\s\S]*?\n\}\n\nfunction renderSummary/,
  `function applyChartMode() {
  const selected = state.chartTypes.slice(0, 3);
  document.querySelectorAll('.trend-grid > [data-trend-key]').forEach(function (item) {
    item.hidden = !selected.includes(item.dataset.trendKey);
  });
  const grid = document.querySelector('.trend-grid');
  if (grid) grid.classList.toggle('single', selected.length === 1);
  const label = selected.map(function (key) { return chartTypeLabels[key] || key; }).join(' / ');
  setText('chart-mode-desc', '当前显示：' + label + '（' + selected.length + ' 个）');
}

function renderSummary`
);

js = js.replace(
  /function drawTrend\(canvasId, values, color\) \{[\s\S]*?\n\}\nfunction renderTrends/,
  `function getTrendMeta(canvasId) {
  const metaMap = {
    'trend-co': { name: 'CO', unit: 'ppm' },
    'trend-alcohol': { name: '酒精', unit: 'adc' },
    'trend-voc': { name: 'VOC', unit: 'index' }
  };
  return metaMap[canvasId] || { name: '', unit: '' };
}
function drawTrend(canvasId, values, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const padding = { left: 42, right: 12, top: 14, bottom: 26 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxRaw = Math.max.apply(null, values.concat([1]));
  const minRaw = Math.min.apply(null, values.concat([0]));
  const max = Math.ceil(maxRaw / 10) * 10 || 10;
  const min = Math.max(0, Math.floor(minRaw / 10) * 10);
  const range = Math.max(max - min, 1);
  const meta = getTrendMeta(canvasId);

  ctx.clearRect(0, 0, width, height);
  ctx.font = '12px Microsoft YaHei, sans-serif';
  ctx.lineWidth = 1;

  ctx.strokeStyle = '#e5e7eb';
  ctx.fillStyle = '#737373';
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotHeight / 4) * i;
    const value = Math.round(max - (range / 4) * i);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(String(value), 6, y + 4);
  }

  ctx.strokeStyle = '#9ca3af';
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  ctx.fillStyle = '#737373';
  ctx.fillText(meta.unit, 6, 12);
  ctx.fillText('时间', width - 34, height - 6);
  ctx.fillText('最新', width - 44, height - padding.bottom + 18);
  ctx.fillText('历史', padding.left, height - padding.bottom + 18);

  if (values.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  values.forEach(function (value, index) {
    const x = padding.left + index * (plotWidth / (values.length - 1));
    const y = padding.top + plotHeight - ((value - min) / range) * plotHeight;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const latest = values[values.length - 1];
  const latestX = width - padding.right;
  const latestY = padding.top + plotHeight - ((latest - min) / range) * plotHeight;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(latestX, latestY, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillText(String(latest), Math.max(padding.left, latestX - 30), Math.max(14, latestY - 8));
}
function renderTrends`
);

fs.writeFileSync(jsPath, js, 'utf8');

console.log('已移除渲染数目选择，并为趋势图添加坐标轴。');
