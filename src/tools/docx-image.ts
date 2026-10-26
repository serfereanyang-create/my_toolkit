import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { ToolDefinition } from './types.js';
import { escapeXml, resolveDesktopPath } from './docx.js';

/*
 * insert_docx_image — create a Word document with embedded images.
 * Supports:
 *   - Local file paths or base64-encoded image data
 *   - PNG, JPEG, GIF formats
 *   - Image sizing (width/height in inches or cm)
 *   - Alignment (left/center/right)
 *   - Optional caption below the image
 * 
 * Input format:
 *   {
 *     path: "desktop/产品介绍.docx",
 *     title: "产品介绍",
 *     images: [
 *       {
 *         source: "/path/to/image.png" or "data:image/png;base64,...",
 *         caption: "图1: 产品外观",
 *         width: 4,  // inches
 *         align: "center"
 *       }
 *     ]
 *   }
 */

type ImageFormat = {
  source: string; // file path or data URI
  caption?: string;
  width?: number; // inches
  height?: number; // inches
  align?: 'left' | 'center' | 'right';
};

function imageExtToContentType(ext: string): string {
  const normalized = ext.toLowerCase().replace('.', '');
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
  if (normalized === 'png') return 'image/png';
  if (normalized === 'gif') return 'image/gif';
  return 'image/png';
}

function emusFromInches(inches: number): number {
  return Math.round(inches * 914400); // 1 inch = 914400 EMUs
}

async function loadImageData(source: string): Promise<{ data: Buffer; ext: string }> {
  // Check if it's a data URI
  const dataUriMatch = source.match(/^data:image\/(png|jpe?g|gif);base64,(.+)$/);
  if (dataUriMatch) {
    const ext = dataUriMatch[1] === 'jpeg' ? 'jpg' : dataUriMatch[1];
    return { data: Buffer.from(dataUriMatch[2], 'base64'), ext };
  }
  
  // Otherwise treat as file path
  const data = await readFile(source);
  const ext = extname(source).replace('.', '') || 'png';
  return { data, ext };
}

function imageXml(imageIndex: number, width: number, height: number, align: 'left' | 'center' | 'right', ext: string): string {
  const widthEmu = emusFromInches(width);
  const heightEmu = emusFromInches(height);
  const rId = `rId${imageIndex + 2}`; // rId1 is document.xml relationship
  
  const drawingXml = `<w:drawing>
    <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
      <wp:extent cx="${widthEmu}" cy="${heightEmu}"/>
      <wp:docPr id="${imageIndex}" name="图片${imageIndex}"/>
      <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:nvPicPr>
              <pic:cNvPr id="${imageIndex}" name="图片${imageIndex}"/>
              <pic:cNvPicPr/>
            </pic:nvPicPr>
            <pic:blipFill>
              <a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
              <a:stretch><a:fillRect/></a:stretch>
            </pic:blipFill>
            <pic:spPr>
              <a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>
              <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            </pic:spPr>
          </pic:pic>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing>`;
  
  const jc = `<w:jc w:val="${align}"/>`;
  return `<w:p><w:pPr>${jc}</w:pPr><w:r>${drawingXml}</w:r></w:p>`;
}

function captionXml(text: string): string {
  if (!text.trim()) return '';
  return `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="666666"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="666666"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

export const insertDocxImageTool: ToolDefinition<{
  path?: string;
  title: string;
  images: ImageFormat[];
}> = {
  name: 'insert_docx_image',
  description:
    'Create a Word document with embedded images. Supports local file paths or data URIs, PNG/JPEG/GIF formats, custom sizing (width/height in inches), alignment (left/center/right), and optional captions. Perfect for reports, presentations, and visual documentation.',
  inputHint:
    '{ "path": "desktop/产品介绍.docx", "title": "产品介绍", "images": [{"source":"/path/to/image.png","caption":"图1: 产品外观","width":4,"align":"center"}] }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (!Array.isArray(record.images)) throw new Error('images must be an array');
    
    return {
      path: typeof record.path === 'string' && record.path.trim() ? record.path.trim() : 'desktop/图片文档.docx',
      title: typeof record.title === 'string' ? record.title : '',
      images: record.images as ImageFormat[],
    };
  },
  async execute(input, context) {
    const target = resolveDesktopPath(input.path ?? 'desktop/图片文档.docx');
    const finalTarget = target.toLowerCase().endsWith('.docx') ? target : `${target}.docx`;
    const checkpoint = await context.checkpoints?.beforeWrite(finalTarget);
    await mkdir(dirname(finalTarget), { recursive: true });
    
    // Load all images
    const imageData: Array<{ data: Buffer; ext: string }> = [];
    for (const img of input.images) {
      try {
        const loaded = await loadImageData(img.source);
        imageData.push(loaded);
      } catch (err) {
        throw new Error(`Failed to load image from ${img.source}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    // Build document body
    const titlePara = input.title.trim()
      ? `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">${escapeXml(input.title)}</w:t></w:r></w:p>`
      : '';
    
    const imageParagraphs = input.images.map((img, i) => {
      const width = img.width ?? 4;
      const height = img.height ?? (width * 0.75); // default 4:3 aspect ratio
      const align = img.align ?? 'center';
      const imgXml = imageXml(i + 1, width, height, align, imageData[i].ext);
      const capXml = img.caption ? captionXml(img.caption) : '';
      return imgXml + capXml;
    }).join('');
    
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${titlePara}${imageParagraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    
    // Build relationships
    const imageRels = imageData.map((img, i) => 
      `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.${img.ext}"/>`
    ).join('');
    const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imageRels}</Relationships>`;
    
    // Build content types
    const imageDefaults = [...new Set(imageData.map(img => img.ext))].map(ext => 
      `<Default Extension="${ext}" ContentType="${imageExtToContentType(ext)}"/>`
    ).join('');
    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${imageDefaults}<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
    
    const files = new Map<string, string | Buffer>([
      ['[Content_Types].xml', contentTypesXml],
      [
        '_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ],
      ['word/document.xml', documentXml],
      ['word/_rels/document.xml.rels', relsXml],
    ]);
    
    // Add image files
    imageData.forEach((img, i) => {
      files.set(`word/media/image${i + 1}.${img.ext}`, img.data);
    });
    
    await writeFile(finalTarget, zipMixed(files));
    await context.checkpoints?.confirm(checkpoint);
    
    return {
      ok: true,
      output: `Created Word document with ${imageData.length} image(s): ${finalTarget}`,
      data: { path: finalTarget, checkpointId: checkpoint?.id, imageCount: imageData.length },
    };
  },
};

// Extended zip function that handles both string (text) and Buffer (binary) content
function zipMixed(files: Map<string, string | Buffer>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  
  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name);
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    // ESM package — a bare require() throws ReferenceError at call time. See
    // the same fix in pptx.ts.
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
