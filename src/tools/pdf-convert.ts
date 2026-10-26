import { access } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from './types.js';

const execAsync = promisify(exec);

/*
 * convert_to_pdf — convert Word (.docx), PowerPoint (.pptx), or Excel (.xlsx) to PDF.
 * Uses LibreOffice in headless mode (--headless --convert-to pdf).
 * 
 * Requirements:
 *   - LibreOffice must be installed on the system
 *   - Windows: soffice.exe in Program Files
 *   - macOS: /Applications/LibreOffice.app/Contents/MacOS/soffice
 *   - Linux: soffice or libreoffice command in PATH
 * 
 * Input format:
 *   {
 *     source: "/path/to/document.docx",
 *     output?: "/path/to/output.pdf"  // optional, defaults to same directory with .pdf extension
 *   }
 */

async function findLibreOffice(): Promise<string> {
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
  ];
  
  // Try candidates first
  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {
      // continue
    }
  }
  
  // Try command in PATH
  try {
    await execAsync('soffice --version');
    return 'soffice';
  } catch {
    try {
      await execAsync('libreoffice --version');
      return 'libreoffice';
    } catch {
      throw new Error('LibreOffice not found. Please install LibreOffice: https://www.libreoffice.org/download/');
    }
  }
}

export const convertToPdfTool: ToolDefinition<{
  source: string;
  output?: string;
}> = {
  name: 'convert_to_pdf',
  description:
    'Convert Word (.docx), PowerPoint (.pptx), or Excel (.xlsx) to PDF using LibreOffice. Preserves formatting, images, and layout. Requires LibreOffice to be installed on the system.',
  inputHint:
    '{ "source": "/path/to/document.docx", "output": "/path/to/output.pdf" }',
  risk: 'write',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.source !== 'string' || !record.source.trim()) throw new Error('source path is required');
    
    const source = record.source.trim();
    const ext = extname(source).toLowerCase();
    if (!['.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls', '.odt', '.odp', '.ods'].includes(ext)) {
      throw new Error('source must be a Word, PowerPoint, Excel, or OpenDocument file');
    }
    
    return {
      source,
      output: typeof record.output === 'string' && record.output.trim() ? record.output.trim() : undefined,
    };
  },
  async execute(input, context) {
    // Check if source exists
    try {
      await access(input.source);
    } catch {
      throw new Error(`Source file not found: ${input.source}`);
    }
    
    // Find LibreOffice
    const soffice = await findLibreOffice();
    
    // Determine output path
    const defaultOutput = input.source.replace(/\.[^.]+$/, '.pdf');
    const outputPath = input.output ?? defaultOutput;
    const outputDir = dirname(outputPath);
    
    const checkpoint = await context.checkpoints?.beforeWrite(outputPath);
    
    // Run LibreOffice conversion
    // --headless: run without GUI
    // --convert-to pdf: convert to PDF format
    // --outdir: output directory
    const command = `"${soffice}" --headless --convert-to pdf --outdir "${outputDir}" "${input.source}"`;
    
    try {
      const { stdout, stderr } = await execAsync(command, { timeout: 60000 });
      
      // LibreOffice generates filename based on source basename, may need to rename
      const sourceBasename = input.source.replace(/\.[^.]+$/, '.pdf').split(/[\\/]/).pop();
      const generatedPath = join(outputDir, sourceBasename!);
      
      // If output path differs from generated path, rename it
      if (generatedPath !== outputPath) {
        try {
          await access(generatedPath);
          await execAsync(`mv "${generatedPath}" "${outputPath}"`);
        } catch {
          // Generated file might already be at outputPath, or conversion failed
        }
      }
      
      // Verify output exists
      try {
        await access(outputPath);
      } catch {
        throw new Error(`PDF generation failed. LibreOffice output: ${stderr || stdout}`);
      }
      await context.checkpoints?.confirm(checkpoint);
      
      return {
        ok: true,
        output: `Converted to PDF: ${outputPath}`,
        data: { path: outputPath, checkpointId: checkpoint?.id },
      };
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ETIMEDOUT') {
        throw new Error('PDF conversion timed out (60s limit). Large files may require longer processing.');
      }
      throw new Error(`LibreOffice conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
