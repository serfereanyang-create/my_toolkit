import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const htmlPath = path.join(root, 'index.html');
const cssPath = path.join(root, 'assets', 'styles.css');
const jsPath = path.join(root, 'assets', 'app.js');

let html = fs.readFileSync(htmlPath, 'utf8');
if (!html.includes('chart-title-row')) {
  html = html
    .replace(/<div data-trend-key="co"><span>CO<\/span><canvas id="trend-co"([^>]*)><\/canvas><\/div>/, '<div data-trend-key="co"><div class="chart-title-row"><span>CO</span><div class="chart-tools"><button type="button" data-chart-zoom="in" data-chart-target="trend-co">＋</button><button type="button" data-chart-zoom="out" data-chart-target="trend-co">－</button><button type="button" data-chart-zoom="reset" data-chart-target="trend-co">复位</button></div></div><canvas id="trend-co"$1></canvas></div>')
    .replace(/<div data-trend-key="alcohol"><span>酒精气体<\/span><canvas id="trend-alcohol"([^>]*)><\/canvas><\/div>/, '<div data-trend-key="alcohol"><div class="chart-title-row"><span>酒精气体</span><div class="chart-tools"><button type="button" data-chart-zoom="in" data-chart-target="trend-alcohol">＋</button><button type="button" data-chart-zoom="out" data-chart-target="trend-alcohol">－</button><button type="button" data-chart-zoom="reset" data-chart-target="trend-alcohol">复位</button></div></div><canvas id="trend-alcohol"$1></canvas></div>')
    .replace(/<div data-trend-key="voc"><span>VOC<\/span><canvas id="trend-voc"([^>]*)><\/canvas><\/div>/, '<div data-trend-key="voc"><div class="chart-title-row"><span>VOC</span><div class="chart-tools"><button type="button" data-chart-zoom="in" data-chart-target="trend-voc">＋</button><button type="button" data-chart-zoom="out" data-chart-target="trend-voc">－</button><button type="button" data-chart-zoom="reset" data-chart-target="trend-voc">复位</button></div></div><canvas id="trend-voc"$1></canvas></div>');
}
fs.writeFileSync(htmlPath, html, 'utf8');

let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('Chart title and zoom tools')) {
  css += `

/* Chart title and zoom tools */
.chart-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.chart-title-row > span {
  display: block;
  color: var(--muted);
  font-size: 24px;
  font-weight: 900;
}

.chart-tools {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--soft-line);
  border-radius: 999px;
  padding: 4px;
  background: #fafafa;
  gap: 4px;
}

.chart-tools button {
  border: 0;
  border-radius: 999px;
  padding: 8px 12px;
  color: var(--text);
  background: #fff;
  cursor: pointer;
  font-weight: 900;
}

.chart-tools button:hover {
  color: #fff;
  background: linear-gradient(135deg, var(--purple), var(--pink), var(--orange));
}
`;
}
fs.writeFileSync(cssPath, css, 'utf8');

let js = fs.readFileSync(jsPath, 'utf8');

js = js.replace('return nearestDistance <= 18 ? nearest : null;', 'return nearestDistance <= 42 ? nearest : null;');
js = js.replace('if (!event.ctrlKey) return;', 'if (!(event.ctrlKey || event.metaKey)) return;');
js = js.replace('const nextScaleX = clamp(view.scaleX * factor, 0.2, 16);', 'const nextScaleX = clamp(view.scaleX * factor, 0.12, 24);');
js = js.replace('const nextScaleY = clamp(view.scaleY * factor, 0.2, 16);', 'const nextScaleY = clamp(view.scaleY * factor, 0.12, 24);');

if (!js.includes('function zoomChartByButton')) {
  js = js.replace(
    'function setupChartInteractions() {',
    `function resetChartView(canvasId) {
  const view = getChartView(canvasId);
  view.scaleX = 1;
  view.scaleY = 1;
  view.offsetX = 0;
  view.offsetY = 0;
  view.activePoint = null;
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
  }, canvas, view);
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
function setupChartInteractions() {`
  );
}

js = js.replace(
  /\n\s*if \(view\.activePoint\) \{[\s\S]*?\n\s*drawTooltip\(ctx, view\.activePoint, area, meta\);\n\s*\}\n\n\s*ctx\.restore\(\);/,
  `
  if (view.activePoint) {
    const updatedPoint = view.points.find(function (point) { return point.index === view.activePoint.index; });
    view.activePoint = updatedPoint || null;
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
  if (activePoint) drawTooltip(ctx, activePoint, area, meta);`
);

if (!js.includes('setupChartToolbar();')) {
  js = js.replace('setupChartModeSelector();\nsetupChartInteractions();', 'setupChartModeSelector();\nsetupChartToolbar();\nsetupChartInteractions();');
}

fs.writeFileSync(jsPath, js, 'utf8');
console.log('已修复图表点选提示，并添加按钮缩放兜底。');
