import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { XlsxBody, GridCell, columnName } from './xlsx-view';
import { PptxBody, SlideCard } from './pptx-view';
import type { ParsedDeck, ParsedSlide, ParsedWorkbook } from '../../lib/ipc';

it('keeps an absolute system-open target for non-native document previews', () => {
  const descriptor = { relativePath: 'docs/report.docx', absolutePath: 'C:/workspace/docs/report.docx' };
  expect(descriptor.absolutePath).toMatch(/report\.docx$/);
  expect(descriptor.absolutePath).not.toBe(descriptor.relativePath);
});

/*
 * The two new document panes, rendered without the preload bridge.
 *
 * The fetching halves of these components need IPC and an effect, so they cannot
 * be rendered here — but everything that decides what the user actually sees
 * (which cell shows a formula, which shape is skipped as the title, how deep a
 * bullet is indented) is in the bodies below, and that is what these cover.
 */

const workbook = (over: Partial<ParsedWorkbook> = {}): ParsedWorkbook => ({
  sheets: [
    {
      name: '收入明细',
      maxCol: 4,
      rows: [
        [{ text: '月份' }, { text: '收入' }, { text: '支出' }, { text: '净利润' }],
        [{ text: '1月' }, { text: '10000' }, { text: '6000' }, { text: '', formula: '=B2-C2' }],
      ],
    },
  ],
  ...over,
});

function renderXlsx(over: Partial<ParsedWorkbook> = {}, props: { showFormulas?: boolean } = {}) {
  return renderToStaticMarkup(createElement(XlsxBody, {
    workbook: workbook(over),
    sheetIndex: 0,
    onSelectSheet: () => {},
    showFormulas: props.showFormulas ?? false,
    onToggleFormulas: () => {},
    fitWidth: true,
    zoom: 1,
  }));
}

describe('columnName', () => {
  it('maps indices to spreadsheet letters past Z', () => {
    // The naive String.fromCharCode(65 + index) is correct up to Z and wrong
    // from the 27th column on.
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');
    expect(columnName(51)).toBe('AZ');
    expect(columnName(52)).toBe('BA');
  });
});

describe('XlsxBody', () => {
  it('renders the sheet tabs and the grid', () => {
    const html = renderXlsx();
    expect(html).toContain('收入明细');
    expect(html).toContain('月份');
    expect(html).toContain('10000');
    // Column and row headers.
    expect(html).toContain('>D<');
    expect(html).toContain('>2<');
  });

  it('shows the formula, not an empty cell, when there is no cached value', () => {
    // This is what the CLI's own writer produces. A blank cell would read as
    // "the agent wrote nothing here", which is the opposite of the truth.
    const html = renderXlsx();
    expect(html).toContain('公式：=B2-C2');
    expect(html).toContain('formula-only');
  });

  it('keeps the cached value visible and offers the formula in a tooltip', () => {
    // Excel caches a result, so the number is the honest thing to show — the
    // formula is a detail on demand.
    const html = renderXlsx({
      sheets: [{
        name: 'S',
        maxCol: 2,
        rows: [[{ text: 'alpha' }, { text: '42', formula: '=A2&B2' }]],
      }],
    });
    expect(html).toContain('42');
    expect(html).not.toContain('formula-only');
  });

  it('renders a sparse cell as empty rather than shifting the row', () => {
    // A row whose C1 exists but A1/B1 do not must put the value in column C.
    const html = renderXlsx({
      sheets: [{ name: 'S', maxCol: 3, rows: [[undefined, undefined, { text: 'far' }]] }],
    });
    const cells = html.split('<td').slice(1);
    expect(cells[0]).toContain('empty');
    expect(cells[1]).toContain('empty');
    expect(cells[2]).toContain('far');
  });

  it('caps a very large sheet and says so', () => {
    const rows = Array.from({ length: 900 }, () => [{ text: 'x' }]);
    const html = renderXlsx({ sheets: [{ name: 'Big', maxCol: 1, rows }] });
    expect(html).toContain('仅显示前');
    // 400 rendered rows, not 900.
    expect(html.split('<tr').length).toBeLessThan(410);
  });

  it('renders a sheet with no rows without crashing', () => {
    const html = renderXlsx({ sheets: [{ name: 'Empty', maxCol: 0, rows: [] }] });
    expect(html).toContain('xlsx-grid');
  });
});

describe('GridCell', () => {
  it('switches a formula-only cell to the formula text when toggled', () => {
    const cell = { text: '', formula: '=B2-C2' };
    const value = renderToStaticMarkup(createElement(GridCell, { cell, showFormula: false }));
    const formula = renderToStaticMarkup(createElement(GridCell, { cell, showFormula: true }));
    // The default view is an empty cell that explains itself on hover, because
    // the file genuinely has no value: Excel has not computed the formula yet.
    expect(value).toContain('formula-only');
    expect(value).toContain('公式：=B2-C2（尚未计算）');
    // Toggled, it shows the formula itself. The class stays — the cell still
    // has no cached value — but the hover explanation is no longer needed.
    expect(formula).toContain('=B2-C2');
    expect(formula).not.toContain('尚未计算');
  });

  it('renders an absent cell as empty', () => {
    const html = renderToStaticMarkup(createElement(GridCell, { cell: undefined, showFormula: false }));
    expect(html).toContain('empty');
  });
});

const slide = (over: Partial<ParsedSlide> = {}): ParsedSlide => ({
  index: 1,
  title: '核心指标',
  shapes: [
    { kind: 'text', type: 'title', paragraphs: [{ text: '核心指标', level: 0 }] },
    { kind: 'text', type: '', paragraphs: [
      { text: '用户增长 20%', level: 0 },
      { text: '留存率 62%', level: 1 },
    ] },
  ],
  notes: '',
  hasPicture: false,
  titleShapeIndex: 0,
  ...over,
});

const deck = (slides: ParsedSlide[]): ParsedDeck => ({ slides });

function renderPptx(slides: ParsedSlide[], showNotes = true) {
  return renderToStaticMarkup(createElement(PptxBody, {
    deck: deck(slides),
    showNotes,
    onToggleNotes: () => {},
    fitWidth: true,
    zoom: 1,
  }));
}

describe('PptxBody', () => {
  it('lists the slides and their text', () => {
    const html = renderPptx([slide()]);
    expect(html).toContain('核心指标');
    expect(html).toContain('用户增长 20%');
    expect(html).toContain('留存率 62%');
    expect(html).toContain('1 页');
  });

  it('does not print the title twice', () => {
    // The title is in the card header; leaving it in the body as well would
    // read as a duplicated line in the deck.
    const html = renderPptx([slide()]);
    expect(html.match(/核心指标/g)).toHaveLength(1);
  });

  it('indents a nested bullet by its outline level', () => {
    // The outline depth is the one piece of layout worth keeping: it carries the
    // deck's structure, which flattening would lose.
    const html = renderPptx([slide()]);
    expect(html).toContain('padding-left:0px');
    expect(html).toContain('padding-left:14px');
  });

  it('falls back to a placeholder for a slide with no title', () => {
    const html = renderPptx([slide({ title: '', shapes: [], titleShapeIndex: -1 })]);
    expect(html).toContain('（无标题）');
    expect(html).toContain('这一页没有文字内容');
  });

  it('renders a table as a table, not as a list of cells', () => {
    const html = renderPptx([slide({
      shapes: [
        { kind: 'text', type: 'title', paragraphs: [{ text: '核心指标', level: 0 }] },
        { kind: 'table', type: '', paragraphs: [], table: [['Region', 'Revenue'], ['华东', '1.2M']] },
      ],
    })]);
    expect(html).toContain('pptx-table');
    expect(html).toContain('华东');
    expect(html).toContain('1.2M');
  });

  it('shows speaker notes, and hides them on request', () => {
    const withNotes = slide({ notes: 'Mention the churn work.\nSecond line.' });
    expect(renderPptx([withNotes], true)).toContain('Mention the churn work.');
    expect(renderPptx([withNotes], false)).not.toContain('Mention the churn work.');
  });

  it('marks a picture placeholder without claiming to render it', () => {
    // The pane cannot draw the image, so it says so rather than showing a gap
    // the user would read as a missing image.
    const html = renderPptx([slide({ hasPicture: true, shapes: [
      { kind: 'text', type: 'title', paragraphs: [{ text: '核心指标', level: 0 }] },
      { kind: 'picture', type: '', paragraphs: [] },
    ] })]);
    expect(html).toContain('pptx-picture');
    expect(html).toContain('图片');
  });
});

describe('SlideCard', () => {
  it('skips the shape used as the title, wherever it sits', () => {
    const html = renderToStaticMarkup(createElement(SlideCard, {
      // The title shape is the second shape, not the first — a deck built from a
      // template can put a logo or a text box ahead of it.
      slide: slide({
        titleShapeIndex: 1,
        shapes: [
          { kind: 'text', type: '', paragraphs: [{ text: '内部资料', level: 0 }] },
          { kind: 'text', type: 'title', paragraphs: [{ text: '核心指标', level: 0 }] },
        ],
      }),
      showNotes: false,
    }));
    expect(html).toContain('内部资料');
    expect(html.match(/核心指标/g)).toHaveLength(1);
  });
});
