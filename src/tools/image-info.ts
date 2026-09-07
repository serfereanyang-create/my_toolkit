import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/**
 * Image metadata and pixel-analysis tools.
 * - image_info: Read single image metadata (dimensions, format)
 * - image_batch_info: Read metadata for multiple images
 * - image_aspect_ratio: Calculate aspect ratio and orientation
 * - image_dominant_colors: Extract representative colors from the image
 * - image_transparency: Report alpha/transparency coverage
 * - image_content_bounds: Detect non-background content bounds
 *
 * Header-only tools stay fast; pixel-analysis tools use sharp for real decoding.
 */

interface ImageInfo {
  format: string;
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: string;
}

type DecodedImage = {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
};

function parseImageInfo(buffer: Buffer): ImageInfo | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    const bitDepth = buffer[24];
    const colorTypeMap: Record<number, string> = {
      0: 'grayscale',
      2: 'RGB',
      3: 'indexed',
      4: 'grayscale+alpha',
      6: 'RGBA',
    };
    const colorType = colorTypeMap[buffer[25]] ?? 'unknown';
    return { format: 'PNG', width, height, bitDepth, colorType };
  }

  // JPEG: FF D8 FF
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xFF) break;
      const marker = buffer[offset + 1];
      if (marker === 0xC0 || marker === 0xC2) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        const bitDepth = buffer[offset + 4];
        return { format: 'JPEG', width, height, bitDepth };
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
    }
    return { format: 'JPEG', width: 0, height: 0 };
  }

  // GIF: 47 49 46 38 (GIF8)
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    return { format: 'GIF', width, height };
  }

  // BMP: 42 4D (BM)
  if (buffer.length >= 30 && buffer[0] === 0x42 && buffer[1] === 0x4D) {
    const width = buffer.readInt32LE(18);
    const height = buffer.readInt32LE(22);
    const bitDepth = buffer.readUInt16LE(28);
    return { format: 'BMP', width, height, bitDepth };
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF...WEBP)
  if (buffer.length >= 30
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x20) {
      const width = buffer.readUInt16LE(26) & 0x3FFF;
      const height = buffer.readUInt16LE(28) & 0x3FFF;
      return { format: 'WebP', width, height };
    }
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x4C) {
      const bits = buffer.readUInt32LE(21);
      const width = (bits & 0x3FFF) + 1;
      const height = ((bits >> 14) & 0x3FFF) + 1;
      return { format: 'WebP', width, height };
    }
    return { format: 'WebP', width: 0, height: 0 };
  }

  return null;
}

async function readHeader(path: string) {
  return readFile(path).then((buf) => buf.slice(0, 10240));
}

async function decodeImage(path: string, maxSide = 256): Promise<DecodedImage> {
  const pipeline = sharp(path, { failOn: 'none' }).rotate();
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Unable to decode image dimensions');
  }

  const resize = metadata.width > maxSide || metadata.height > maxSide
    ? { width: maxSide, height: maxSide, fit: 'inside' as const }
    : undefined;

  const { data, info } = await pipeline
    .resize(resize)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    data,
  };
}

function toHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function brightness(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export const imageInfoTool: ToolDefinition<{ path: string }> = {
  name: 'image_info',
  description:
    'Read image metadata including format, dimensions (width/height), bit depth, and color type. Supports PNG, JPEG, GIF, BMP, and WebP. Fast header-only parsing without loading the entire image into memory.',
  inputHint: '{ "path": "desktop/photo.jpg" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    return { path: record.path.trim() };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    const buffer = await readHeader(target);
    const info = parseImageInfo(buffer);
    if (!info) {
      return {
        ok: false,
        output: `Unable to parse image format from: ${input.path}\nSupported formats: PNG, JPEG, GIF, BMP, WebP`,
      };
    }

    const details: string[] = [
      `Format: ${info.format}`,
      `Dimensions: ${info.width} × ${info.height}`,
    ];
    if (info.bitDepth !== undefined) details.push(`Bit depth: ${info.bitDepth}`);
    if (info.colorType) details.push(`Color type: ${info.colorType}`);

    return {
      ok: true,
      output: `Image info for ${input.path}:\n${details.join('\n')}`,
      data: { path: input.path, ...info },
    };
  },
};

export const imageBatchInfoTool: ToolDefinition<{ paths: string[]; maxFiles: number }> = {
  name: 'image_batch_info',
  description:
    'Read metadata for multiple images in a single call. Returns format, dimensions, and file path for each image. Useful for batch processing or gallery analysis.',
  inputHint: '{ "paths": ["photo1.jpg", "photo2.png"], "maxFiles": 50 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (!Array.isArray(record.paths) || record.paths.length === 0) throw new Error('paths must be a non-empty array');
    const maxFiles = typeof record.maxFiles === 'number' ? Math.max(1, Math.min(200, record.maxFiles)) : 50;
    return {
      paths: record.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0),
      maxFiles,
    };
  },
  async execute(input, context) {
    const results: Array<{ path: string; info: ImageInfo | null; error?: string }> = [];
    const processed = input.paths.slice(0, input.maxFiles);
    for (const itemPath of processed) {
      try {
        const target = resolveReadablePath(context.workspaceRoot, itemPath);
        const buffer = await readHeader(target);
        results.push({ path: itemPath, info: parseImageInfo(buffer) });
      } catch (error) {
        results.push({ path: itemPath, info: null, error: String(error) });
      }
    }

    const listing = results.map((result) => {
      if (result.info) return `${result.path.padEnd(40)} ${result.info.format.padEnd(6)} ${result.info.width} × ${result.info.height}`;
      return `${result.path.padEnd(40)} FAILED ${result.error || 'unknown error'}`;
    }).join('\n');

    return {
      ok: true,
      output: `Batch image info: ${results.filter((item) => item.info).length} success, ${results.filter((item) => !item.info).length} failed\n\n${listing}`,
      data: {
        images: results,
        successCount: results.filter((item) => item.info).length,
        failedCount: results.filter((item) => !item.info).length,
      },
    };
  },
};

export const imageAspectRatioTool: ToolDefinition<{ path: string }> = {
  name: 'image_aspect_ratio',
  description:
    'Calculate aspect ratio and orientation (landscape/portrait/square) for an image. Useful for layout decisions and responsive design.',
  inputHint: '{ "path": "photo.jpg" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    return { path: record.path.trim() };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    const buffer = await readHeader(target);
    const info = parseImageInfo(buffer);
    if (!info || info.width === 0 || info.height === 0) {
      return { ok: false, output: `Unable to parse dimensions from: ${input.path}` };
    }

    const divisor = gcd(info.width, info.height);
    const ratioW = info.width / divisor;
    const ratioH = info.height / divisor;
    const decimalRatio = (info.width / info.height).toFixed(3);
    const orientation = info.width > info.height ? 'landscape' : info.height > info.width ? 'portrait' : 'square';
    const commonRatios: Record<string, string> = {
      '1:1': 'square',
      '4:3': '4:3 (standard)',
      '3:2': '3:2 (35mm film)',
      '16:9': '16:9 (widescreen)',
      '16:10': '16:10 (computer)',
      '21:9': '21:9 (ultrawide)',
      '9:16': '9:16 (mobile portrait)',
    };
    const ratioKey = `${ratioW}:${ratioH}`;

    return {
      ok: true,
      output: `Aspect ratio for ${input.path}:\n${info.width} × ${info.height}\nRatio: ${commonRatios[ratioKey] || ratioKey} (${decimalRatio})\nOrientation: ${orientation}`,
      data: {
        path: input.path,
        width: info.width,
        height: info.height,
        ratioSimplified: ratioKey,
        ratioDecimal: parseFloat(decimalRatio),
        orientation,
      },
    };
  },
};

export const imageDominantColorsTool: ToolDefinition<{ path: string; maxColors: number }> = {
  name: 'image_dominant_colors',
  description:
    'Decode an image and extract representative dominant colors with approximate coverage. Useful for theme extraction, visual QA, and palette analysis.',
  inputHint: '{ "path": "photo.jpg", "maxColors": 5 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    const maxColors = typeof record.maxColors === 'number' ? Math.max(1, Math.min(8, Math.floor(record.maxColors))) : 5;
    return { path: record.path.trim(), maxColors };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    const image = await decodeImage(target, 192);
    const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();

    for (let index = 0; index < image.data.length; index += image.channels) {
      const alpha = image.data[index + 3] ?? 255;
      if (alpha < 16) continue;
      const r = image.data[index] ?? 0;
      const g = image.data[index + 1] ?? 0;
      const b = image.data[index + 2] ?? 0;
      const key = `${Math.round(r / 32) * 32}-${Math.round(g / 32) * 32}-${Math.round(b / 32) * 32}`;
      const entry = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      entry.count += 1;
      entry.r += r;
      entry.g += g;
      entry.b += b;
      buckets.set(key, entry);
    }

    const ranked = [...buckets.values()]
      .sort((left, right) => right.count - left.count)
      .slice(0, input.maxColors)
      .map((entry) => {
        const r = Math.round(entry.r / entry.count);
        const g = Math.round(entry.g / entry.count);
        const b = Math.round(entry.b / entry.count);
        return {
          hex: toHex(r, g, b),
          rgb: [r, g, b] as [number, number, number],
          coverage: entry.count / (image.width * image.height),
          brightness: brightness(r, g, b),
        };
      });

    return {
      ok: true,
      output: `Dominant colors for ${input.path}:\n${ranked.map((item, index) => `${index + 1}. ${item.hex} ${formatPercent(item.coverage)}`).join('\n')}`,
      data: {
        path: input.path,
        analyzedSize: { width: image.width, height: image.height },
        colors: ranked,
      },
    };
  },
};

export const imageTransparencyTool: ToolDefinition<{ path: string }> = {
  name: 'image_transparency',
  description:
    'Detect whether an image uses alpha transparency and report transparent, semi-transparent, and opaque pixel coverage.',
  inputHint: '{ "path": "icon.png" }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    return { path: record.path.trim() };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    const image = await decodeImage(target, 256);
    let transparent = 0;
    let semiTransparent = 0;
    let opaque = 0;

    for (let index = 0; index < image.data.length; index += image.channels) {
      const alpha = image.data[index + 3] ?? 255;
      if (alpha === 0) transparent += 1;
      else if (alpha < 255) semiTransparent += 1;
      else opaque += 1;
    }

    const total = transparent + semiTransparent + opaque || 1;

    return {
      ok: true,
      output: `Transparency for ${input.path}:\nTransparent: ${formatPercent(transparent / total)}\nSemi-transparent: ${formatPercent(semiTransparent / total)}\nOpaque: ${formatPercent(opaque / total)}`,
      data: {
        path: input.path,
        hasTransparency: transparent > 0 || semiTransparent > 0,
        transparentPixels: transparent,
        semiTransparentPixels: semiTransparent,
        opaquePixels: opaque,
        totalPixels: total,
      },
    };
  },
};

export const imageContentBoundsTool: ToolDefinition<{ path: string; background?: 'auto' | 'white' | 'black'; threshold: number }> = {
  name: 'image_content_bounds',
  description:
    'Detect the bounding box of non-background content in an image. Useful for trimming whitespace, checking icon padding, and estimating content density.',
  inputHint: '{ "path": "scan.png", "background": "auto", "threshold": 12 }',
  risk: 'read',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    const background = record.background === 'white' || record.background === 'black' ? record.background : 'auto';
    const threshold = typeof record.threshold === 'number' ? Math.max(0, Math.min(64, Math.floor(record.threshold))) : 12;
    return { path: record.path.trim(), background, threshold };
  },
  async execute(input, context) {
    const target = resolveReadablePath(context.workspaceRoot, input.path);
    const image = await decodeImage(target, 256);

    const sample = (pixelIndex: number) => ({
      r: image.data[pixelIndex] ?? 0,
      g: image.data[pixelIndex + 1] ?? 0,
      b: image.data[pixelIndex + 2] ?? 0,
      a: image.data[pixelIndex + 3] ?? 255,
    });

    const corners = [
      sample(0),
      sample((image.width - 1) * image.channels),
      sample((image.height - 1) * image.width * image.channels),
      sample(((image.height - 1) * image.width + (image.width - 1)) * image.channels),
    ];

    const autoWhiteScore = corners.reduce((sum, item) => sum + brightness(item.r, item.g, item.b), 0) / corners.length;
    const background = input.background === 'auto' ? (autoWhiteScore >= 127 ? 'white' : 'black') : input.background;
    const bg = background === 'white' ? 255 : 0;

    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;
    let contentPixels = 0;

    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const index = (y * image.width + x) * image.channels;
        const a = image.data[index + 3] ?? 255;
        const r = image.data[index] ?? 0;
        const g = image.data[index + 1] ?? 0;
        const b = image.data[index + 2] ?? 0;
        const delta = Math.max(Math.abs(r - bg), Math.abs(g - bg), Math.abs(b - bg));
        const isContent = a > 16 && delta > input.threshold;
        if (!isContent) continue;
        contentPixels += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    if (contentPixels === 0) {
      return {
        ok: true,
        output: `Content bounds for ${input.path}: no non-background content detected`,
        data: {
          path: input.path,
          background,
          threshold: input.threshold,
          empty: true,
        },
      };
    }

    const bounds = {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };

    return {
      ok: true,
      output: `Content bounds for ${input.path}:\nBounds: x=${bounds.left}..${bounds.right}, y=${bounds.top}..${bounds.bottom}\nSize: ${bounds.width} × ${bounds.height}\nCoverage: ${formatPercent(contentPixels / (image.width * image.height))}\nBackground: ${background}`,
      data: {
        path: input.path,
        analyzedSize: { width: image.width, height: image.height },
        background,
        threshold: input.threshold,
        contentPixels,
        bounds,
      },
    };
  },
};
