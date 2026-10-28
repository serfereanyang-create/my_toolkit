import { analyzeCacheHealth, formatCacheHealth } from '../dist/src/usage/cacheHealth.js';

const report = await analyzeCacheHealth({ limit: 60 });
console.log(formatCacheHealth(report));
console.log('\n--- endpoints(raw) ---');
console.log(JSON.stringify(report.endpoints, null, 2));
console.log('\n--- toolSurfaceShifts ---');
console.log(JSON.stringify(report.toolSurfaceShifts, null, 2));
console.log('\n--- patternCounts ---');
console.log(JSON.stringify(report.patternCounts, null, 2));
