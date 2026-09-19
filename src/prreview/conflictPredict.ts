/**
 * conflictPredict.ts - Predict merge-conflict hotspots from two branch diffs.
 *
 * Compares `git diff` between two refs against a shared merge-base and flags
 * files / ranges touched by both branches. Read-only; never merges.
 */

import type { ParsedDiff, FileDiff } from './diffModel.js';
import { parseUnifiedDiff } from './diffModel.js';

export interface ConflictHotspot {
  file: string;
  reason: 'both-modified' | 'both-added' | 'modified-vs-deleted' | 'deleted-vs-deleted' | 'renamed-conflict';
  /** Rough line-range on each side (best effort) */
  sideA: { start: number; end: number } | null;
  sideB: { start: number; end: number } | null;
}

export interface ConflictReport {
  filesA: number;
  filesB: number;
  sharedFiles: number;
  hotspots: ConflictHotspot[];
  riskScore: number;
}

function lineRangeFor(file: FileDiff): { start: number; end: number } | null {
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;
  for (const h of file.hunks) {
    const start = h.newStart;
    const end = h.newStart + Math.max(h.newLines, 1) - 1;
    if (start < minStart) minStart = start;
    if (end > maxEnd) maxEnd = end;
  }
  if (!Number.isFinite(minStart)) return null;
  return { start: minStart, end: maxEnd };
}

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export function predictConflicts(diffA: ParsedDiff, diffB: ParsedDiff): ConflictReport {
  const mapA = new Map<string, FileDiff>();
  for (const f of diffA.files) mapA.set(f.path, f);
  const mapB = new Map<string, FileDiff>();
  for (const f of diffB.files) mapB.set(f.path, f);

  const hotspots: ConflictHotspot[] = [];

  const sharedPaths = [...mapA.keys()].filter((p) => mapB.has(p));
  for (const path of sharedPaths) {
    const a = mapA.get(path)!;
    const b = mapB.get(path)!;
    let reason: ConflictHotspot['reason'];
    if (a.kind === 'deleted' && b.kind === 'deleted') reason = 'deleted-vs-deleted';
    else if (a.kind === 'deleted' || b.kind === 'deleted') reason = 'modified-vs-deleted';
    else if (a.kind === 'added' && b.kind === 'added') reason = 'both-added';
    else if (a.kind === 'renamed' || b.kind === 'renamed') reason = 'renamed-conflict';
    else reason = 'both-modified';

    hotspots.push({
      file: path,
      reason,
      sideA: lineRangeFor(a),
      sideB: lineRangeFor(b),
    });
  }

  // 额外：A 删除的文件被 B 修改（不算同名同路径但路径自身不同）
  for (const file of diffA.files) {
    if (file.kind !== 'deleted') continue;
    for (const b of diffB.files) {
      if (b.kind === 'deleted') continue;
      if (b.path === file.path || b.path.startsWith(file.path + '/')) {
        if (!hotspots.some((h) => h.file === b.path || h.file === file.path)) {
          hotspots.push({
            file: b.path,
            reason: 'modified-vs-deleted',
            sideA: lineRangeFor(file),
            sideB: lineRangeFor(b),
          });
        }
      }
    }
  }

  // 计算 score：重叠越多越高
  let score = 0;
  for (const h of hotspots) {
    let base = 2;
    if (h.reason === 'modified-vs-deleted') base = 4;
    if (h.reason === 'renamed-conflict') base = 3;
    if (h.reason === 'both-added') base = 3;
    if (h.sideA && h.sideB && rangesOverlap(h.sideA, h.sideB)) base += 3;
    score += base;
  }

  return {
    filesA: diffA.files.length,
    filesB: diffB.files.length,
    sharedFiles: sharedPaths.length,
    hotspots,
    riskScore: Math.min(100, score * 5),
  };
}

/** Convenience: parse two diff texts and compute the report. */
export function analyzeTwoDiffs(textA: string, textB: string): ConflictReport {
  return predictConflicts(parseUnifiedDiff(textA), parseUnifiedDiff(textB));
}
