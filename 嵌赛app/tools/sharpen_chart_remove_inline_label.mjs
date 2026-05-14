import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const htmlPath = path.join(root, 'index.html');
const jsPath = path.join(root, 'assets', 'app.js');

let html = fs.readFileSync(htmlPath, 'utf8');
html = html.replaceAll('width="720" height="260"', 'width="1440" height="520"');
fs.writeFileSync(htmlPath, html, 'utf8');

let js = fs.readFileSync(jsPath, 'utf8');

js = js.replace(
  "ctx.fillText('y=' + latest.value + (meta.unit ? ' ' + meta.unit : ''), Math.max(area.left, latest.x - 68), Math.max(area.top + 18, latest.y - 10));",
  ""
);

js = js.replace("ctx.lineWidth = 4;", "ctx.lineWidth = 5;");
js = js.replace("ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);", "ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);");
js = js.replace("ctx.font = '16px Microsoft YaHei, sans-serif';", "ctx.font = '18px Microsoft YaHei, sans-serif';");
js = js.replace("ctx.lineWidth = 2;", "ctx.lineWidth = 2.5;");

fs.writeFileSync(jsPath, js, 'utf8');

console.log('已移除线上常驻 y 标注，并提高 canvas 内部分辨率。');
