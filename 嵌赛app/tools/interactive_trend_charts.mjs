import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const jsPath = path.join(root, 'assets', 'app.js');
const cssPath = path.join(root, 'assets', 'styles.css');

let js = fs.readFileSync(jsPath, 'utf8');

if (!js.includes('const chartViews = {};')) {
  js = js.replace(
    "const chartTypeLabels = { co: 'CO', alcohol: '酒精', voc: 'VOC' };",
    "const chartTypeLabels = { co: 'CO', alcohol: '酒精', voc: 'VOC' };\nconst chartViews = {};"
  );
}

const interactiveChartCode = `function getTrendMeta(canvasId) {
  const metaMap = {
    'trend-co': { name: 'CO', unit: 'ppm' },
    'trend-alcohol': { name: '酒精', unit: 'adc' },
    'trend-voc': { name: 'VOC', unit: 'index' }
  };
  return metaMap[canvasId] || { name: '', unit: '' };
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
function getPlotArea(width, height) {
  const padding = { left: 76, right: 42, top: 38, bottom: 58 };
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
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height)
  };
}
function isInsidePlot(point, area) {
  return point.x >= area.left && point.x <= area.right && point.y >= area.top && point.y <= area.bottom;
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
  return nearestDistance <= 18 ? nearest : null;
}
function setupChartInteractions() {
  ['trend-co', 'trend-alcohol', 'trend-voc'].forEach(function (canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const view = getChartView(canvasId);

    canvas.addEventListener('pointerdown', function (event) {
      const point = getCanvasPointer(event, canvas);
      const area = getPlotArea(canvas.width, canvas.height);
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

    canvas.addEventListener('wheel', function (event) {
      const point = getCanvasPointer(event, canvas);
      const area = getPlotArea(canvas.width, canvas.height);
      if (!isInsidePlot(point, area)) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 0.88;
      const nextScaleX = clamp(view.scaleX * factor, 0.55, 8);
      const nextScaleY = clamp(view.scaleY * factor, 0.55, 8);
      const contentX = (point.x - area.left - view.offsetX) / view.scaleX;
      const contentY = (point.y - area.top - view.offsetY) / view.scaleY;
      view.offsetX = point.x - area.left - contentX * nextScaleX;
      view.offsetY = point.y - area.top - contentY * nextScaleY;
      view.scaleX = nextScaleX;
      view.scaleY = nextScaleY;
      renderTrends();
    }, { passive: false });

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
  const valueText = meta.name + ': ' + point.value + (meta.unit ? ' ' + meta.unit : '');
  const indexText = '点位 #' + (point.index + 1);
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
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const area = getPlotArea(width, height);
  const maxRaw = Math.max.apply(null, values.concat([1]));
  const minRaw = Math.min.apply(null, values.concat([0]));
  const max = Math.ceil(maxRaw / 10) * 10 || 10;
  const min = Math.max(0, Math.floor(minRaw / 10) * 10);
  const range = Math.max(max - min, 1);
  const meta = getTrendMeta(canvasId);
  const view = getChartView(canvasId);

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
    ctx.fillText(String(value), 12, y + 5);
  }

  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(area.left, area.top);
  ctx.lineTo(area.left, area.bottom);
  ctx.lineTo(area.right, area.bottom);
  ctx.stroke();

  ctx.fillStyle = '#737373';
  ctx.fillText(meta.unit, 8, 24);
  ctx.fillText('时间', width - 52, height - 12);
  ctx.fillText('历史', area.left, height - 20);
  ctx.fillText('最新', area.right - 44, height - 20);

  view.points = [];
  if (values.length < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.left, area.top, area.width, area.height);
  ctx.clip();

  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  values.forEach(function (value, index) {
    const baseX = area.left + index * (area.width / (values.length - 1));
    const baseY = area.top + area.height - ((value - min) / range) * area.height;
    const x = area.left + (baseX - area.left) * view.scaleX + view.offsetX;
    const y = area.top + (baseY - area.top) * view.scaleY + view.offsetY;
    view.points.push({ x, y, value, index });
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  view.points.forEach(function (point) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });

  const latest = view.points[view.points.length - 1];
  if (latest) {
    ctx.fillStyle = color;
    ctx.font = '16px Microsoft YaHei, sans-serif';
    ctx.fillText(String(latest.value), Math.max(area.left, latest.x - 30), Math.max(area.top + 18, latest.y - 10));
  }

  if (view.activePoint) {
    ctx.strokeStyle = 'rgba(17, 24, 39, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(view.activePoint.x, area.top);
    ctx.lineTo(view.activePoint.x, area.bottom);
    ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(view.activePoint.x, view.activePoint.y, 7, 0, Math.PI * 2);
    ctx.fill();
    drawTooltip(ctx, view.activePoint, area, meta);
  }

  ctx.restore();
}
function renderTrends`;

js = js.replace(/function getTrendMeta\(canvasId\) \{[\s\S]*?\n\}\nfunction renderTrends/, interactiveChartCode);

if (!js.includes('setupChartInteractions();')) {
  js = js.replace('setupChartModeSelector();\ntick();', 'setupChartModeSelector();\nsetupChartInteractions();\ntick();');
}

fs.writeFileSync(jsPath, js, 'utf8');

let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('.trend-grid canvas.dragging')) {
  css += `

.trend-grid canvas {
  cursor: grab;
  touch-action: none;
}

.trend-grid canvas.dragging {
  cursor: grabbing;
}
`;
  fs.writeFileSync(cssPath, css, 'utf8');
}

console.log('已添加趋势图拖动、缩放和点选提示。');
