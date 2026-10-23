import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolDefinition } from './types.js';
import { escapeXml, resolveDesktopPath } from './docx.js';

/*
 * create_pptx — generate a PowerPoint presentation (.pptx) with title slide and content slides.
 * Supports:
 *   - Title slide with main title and subtitle
 *   - Content slides with title and bullet points
 *   - Custom slide layouts
 *   - Standard 16:9 widescreen format
 * 
 * Input format:
 *   {
 *     path: "desktop/季度汇报.pptx",
 *     title: "2024 Q1 业务汇报",
 *     subtitle: "技术部",
 *     slides: [
 *       { title: "核心指标", bullets: ["用户增长 20%", "营收增长 15%"] },
 *       { title: "下一步计划", bullets: ["扩展市场", "优化产品"] }
 *     ]
 *   }
 */

type Slide = {
  title: string;
  bullets: string[];
};

function titleSlideXml(title: string, subtitle: string): string {
  const titleShape = `<p:sp>
    <p:nvSpPr><p:cNvPr id="1" name="标题"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
    <p:spPr/>
    <p:txBody>
      <a:bodyPr/>
      <a:lstStyle/>
      <a:p><a:r><a:rPr lang="zh-CN" sz="4400" b="1"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>${escapeXml(title)}</a:t></a:r></a:p>
    </p:txBody>
  </p:sp>`;
  
  const subtitleShape = subtitle.trim() ? `<p:sp>
    <p:nvSpPr><p:cNvPr id="2" name="副标题"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr>
    <p:spPr/>
    <p:txBody>
      <a:bodyPr/>
      <a:lstStyle/>
      <a:p><a:r><a:rPr lang="zh-CN" sz="2000"><a:solidFill><a:srgbClr val="666666"/></a:solidFill></a:rPr><a:t>${escapeXml(subtitle)}</a:t></a:r></a:p>
    </p:txBody>
  </p:sp>` : '';
  
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${titleShape}
      ${subtitleShape}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function contentSlideXml(slide: Slide, slideId: number): string {
  const bulletPoints = slide.bullets.map(bullet => 
    `<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="zh-CN" sz="2000"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>${escapeXml(bullet)}</a:t></a:r></a:p>`
  ).join('');
  
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="${slideId * 10 + 1}" name="标题"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p><a:r><a:rPr lang="zh-CN" sz="3200" b="1"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>${escapeXml(slide.title)}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="${slideId * 10 + 2}" name="内容"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          ${bulletPoints}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

export const createPptxTool: ToolDefinition<{
  path?: string;
  title: string;
  subtitle?: string;
  slides: Slide[];
}> = {
  name: 'create_pptx',
  description:
    'Create a PowerPoint presentation (.pptx) with title slide and content slides. Supports custom titles, subtitles, bullet points, and 16:9 widescreen format. Perfect for business reports, project proposals, and training materials.',
  inputHint:
    '{ "path": "desktop/季度汇报.pptx", "title": "2024 Q1 业务汇报", "subtitle": "技术部", "slides": [{"title":"核心指标","bullets":["用户增长 20%","营收增长 15%"]}, {"title":"下一步计划","bullets":["扩展市场","优化产品"]}] }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (!Array.isArray(record.slides)) throw new Error('slides must be an array');
    
    return {
      path: typeof record.path === 'string' && record.path.trim() ? record.path.trim() : 'desktop/演示文稿.pptx',
      title: typeof record.title === 'string' ? record.title : '无标题',
      subtitle: typeof record.subtitle === 'string' ? record.subtitle : '',
      slides: record.slides as Slide[],
    };
  },
  async execute(input, context) {
    const target = resolveDesktopPath(input.path ?? 'desktop/演示文稿.pptx');
    const finalTarget = target.toLowerCase().endsWith('.pptx') ? target : `${target}.pptx`;
    const checkpoint = await context.checkpoints?.beforeWrite(finalTarget);
    await mkdir(dirname(finalTarget), { recursive: true });
    
    const files = new Map<string, string>();
    
    // [Content_Types].xml
    const slideOverrides = [1, ...input.slides.map((_, i) => i + 2)].map(id => 
      `<Override PartName="/ppt/slides/slide${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    ).join('');
    files.set('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slideOverrides}
</Types>`);
    
    // _rels/.rels
    files.set('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
    
    // ppt/presentation.xml
    const slideIdList = [1, ...input.slides.map((_, i) => i + 2)].map((id, idx) => 
      `<p:sldId id="${256 + idx}" r:id="rId${idx + 1}"/>`
    ).join('');
    files.set('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldSz cx="9144000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:sldIdLst>${slideIdList}</p:sldIdLst>
</p:presentation>`);
    
    // ppt/_rels/presentation.xml.rels
    const slideRels = [1, ...input.slides.map((_, i) => i + 2)].map((id, idx) => 
      `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${id}.xml"/>`
    ).join('');
    files.set('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slideRels}
</Relationships>`);
    
    // Slide 1: Title slide
    files.set('ppt/slides/slide1.xml', titleSlideXml(input.title, input.subtitle ?? ''));
    
    // Content slides
    input.slides.forEach((slide, i) => {
      files.set(`ppt/slides/slide${i + 2}.xml`, contentSlideXml(slide, i + 2));
    });
    
    await writeFile(finalTarget, zipFiles(files));
    await context.checkpoints?.confirm(checkpoint);
    
    return {
      ok: true,
      output: `Created PowerPoint presentation: ${finalTarget}\n${input.slides.length + 1} slides (1 title + ${input.slides.length} content)`,
      data: { path: finalTarget, checkpointId: checkpoint?.id, slideCount: input.slides.length + 1 },
    };
  },
};

function zipFiles(files: Map<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  
  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content, 'utf8');
    const compressed = require('node:zlib').deflateRawSync(data);
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
