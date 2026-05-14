import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const jsPath = path.join(root, 'assets', 'app.js');
const cssPath = path.join(root, 'assets', 'styles.css');

let js = fs.readFileSync(jsPath, 'utf8');

if (!js.includes('function applyWheelZoom(event, canvas, view)')) {
  js = js.replace(
    "function setupChartInteractions() {",
    `function applyWheelZoom(event, canvas, view) {
  event.preventDefault();
  event.stopPropagation();
  const point = getCanvasPointer(event, canvas);
  const size = syncCanvasResolution(canvas);
  const area = getPlotArea(size.width, size.height);
  const focusX = clamp(point.x, area.left, area.right);
  const focusY = clamp(point.y, area.top, area.bottom);
  const factor = event.deltaY < 0 ? 1.18 : 0.84;
  const nextScaleX = clamp(view.scaleX * factor, 0.2, 16);
  const nextScaleY = clamp(view.scaleY * factor, 0.2, 16);
  const contentX = (focusX - area.left - view.offsetX) / Math.max(view.scaleX, 0.001);
  const contentY = (focusY - area.top - view.offsetY) / Math.max(view.scaleY, 0.001);
  view.offsetX = focusX - area.left - contentX * nextScaleX;
  view.offsetY = focusY - area.top - contentY * nextScaleY;
  view.scaleX = nextScaleX;
  view.scaleY = nextScaleY;
  renderTrends();
}
function setupChartInteractions() {`
  );
}

js = js.replace(
  /\n\s*canvas\.addEventListener\('wheel', function \(event\) \{[\s\S]*?\n\s*\}, \{ passive: false \}\);/,
  `
    const wheelZoom = function (event) {
      applyWheelZoom(event, canvas, view);
    };
    canvas.addEventListener('wheel', wheelZoom, { passive: false });
    if (canvas.parentElement) {
      canvas.parentElement.addEventListener('wheel', wheelZoom, { passive: false });
    }`
);

fs.writeFileSync(jsPath, js, 'utf8');

let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('Wheel zoom containment for chart cards')) {
  css += `

/* Wheel zoom containment for chart cards */
.trend-grid > div {
  overscroll-behavior: contain;
}

.trend-grid canvas {
  user-select: none;
}
`;
}
fs.writeFileSync(cssPath, css, 'utf8');

console.log('已修复趋势图滚轮缩放事件绑定。');
