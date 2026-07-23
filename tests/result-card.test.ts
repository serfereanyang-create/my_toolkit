import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatResultCard, isMetaTranslatedDone, summarizeToolLine } from '../src/ui/resultCard.js';

test('formatResultCard builds disk conclusion card in Chinese', () => {
  const card = formatResultCard({
    tool: 'disk_info',
    locale: 'zh',
    output: 'name\tpath\tusedGB\tfreeGB\ttotalGB\nC:\tC:/\t224.77\t188.01\t412.79',
    data: { disks: [{ name: 'C:', path: 'C:/', usedGb: 224.77, freeGb: 188.01, totalGb: 412.79 }] },
  });
  assert.match(card ?? '', /结论：C: 磁盘还有可用空间/);
  assert.match(card ?? '', /188\.01/);
  assert.match(card ?? '', /下一步：/);
  assert.doesNotMatch(card ?? '', /Done\. I translated/);
});

test('formatResultCard builds process memory card', () => {
  const card = formatResultCard({
    tool: 'process_memory',
    locale: 'zh',
    output: 'name\tpid\tmemoryMB\nSteam\t1\t900',
    data: { processes: [{ name: 'Steam', pid: 1, memoryMb: 900 }, { name: 'Explorer', pid: 2, memoryMb: 200 }] },
  });
  assert.match(card ?? '', /结论：当前内存占用较高的进程如下/);
  assert.match(card ?? '', /Steam/);
});

test('isMetaTranslatedDone detects mock meta finals', () => {
  assert.equal(isMetaTranslatedDone('Done. I translated the natural-language request into 1 tool call(s).'), true);
  assert.equal(isMetaTranslatedDone('结论：C: 磁盘还有可用空间。'), false);
});

test('summarizeToolLine folds disk data into one line', () => {
  const line = summarizeToolLine({
    tool: 'disk_info',
    ok: true,
    duration: '1ms',
    locale: 'zh',
    data: { disks: [{ name: 'C:', freeGb: 188.01, totalGb: 412.79, usedGb: 224.77 }] },
  });
  assert.match(line, /disk_info ok 1ms · 可用 188\.01GB/);
});
