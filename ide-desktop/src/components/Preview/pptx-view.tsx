import { StickyNote } from 'lucide-react';
import type { ParsedDeck, ParsedSlide } from '../../lib/ipc';

/*
 * The rendered deck, as a pure component — split from PptxPreview.tsx, which
 * fetches over IPC, so it can be rendered in a plain `renderToStaticMarkup`
 * test.
 *
 * This is deliberately not a slide renderer. Reproducing PowerPoint's layout —
 * placeholders, slide masters, theme fonts, autofit, z-order — is a project of
 * its own, and a half-accurate rendering would be worse than none: it would show
 * a slide that does not look like the slide, and the user cannot tell which
 * parts are the deck and which are the approximation.
 *
 * So the pane shows what a reader actually needs and what can be shown
 * faithfully: the slide list, each slide's title, its text in outline order with
 * the outline levels preserved, tables as tables, and the speaker notes. The
 * "open in system app" button is the path to seeing the real layout.
 */

export function PptxBody({
  deck, showNotes, onToggleNotes, fitWidth, zoom,
}: {
  deck: ParsedDeck;
  showNotes: boolean;
  onToggleNotes: () => void;
  fitWidth: boolean;
  zoom: number;
}) {
  return (
    <div className={`pptx-preview ${fitWidth ? 'fit-width' : ''}`} style={fitWidth ? {} : { zoom }}>
      <div className="pptx-toolbar">
        <span className="pptx-count">{deck.slides.length} 页</span>
        <button
          className={`icon-btn ${showNotes ? 'active' : ''}`}
          title={showNotes ? '隐藏备注' : '显示备注'}
          aria-pressed={showNotes}
          onClick={onToggleNotes}
        ><StickyNote size={13} /></button>
      </div>

      <div className="pptx-slides">
        {deck.slides.map((slide) => (
          <SlideCard key={slide.index} slide={slide} showNotes={showNotes} />
        ))}
      </div>

      {deck.truncated && <p className="pptx-note" role="note">演示文稿页数较多，仅显示前面部分。</p>}
    </div>
  );
}

export function SlideCard({ slide, showNotes }: { slide: ParsedSlide; showNotes: boolean }) {
  return (
    <section className="pptx-slide" aria-label={`第 ${slide.index} 页`}>
      <header className="pptx-slide-head">
        <span className="pptx-slide-number">{slide.index}</span>
        <h3 className="pptx-slide-title">{slide.title || <em className="pptx-untitled">（无标题）</em>}</h3>
      </header>

      <div className="pptx-slide-body">
        {slide.shapes.length === 0 && <p className="pptx-empty">这一页没有文字内容。</p>}
        {slide.shapes.map((shape, index) => {
          // The title already appears in the card header; printing it again in
          // the body would read as a duplicated line.
          if (index === slide.titleShapeIndex) return null;
          if (shape.kind === 'picture') {
            // The pane cannot draw the image, so it says so rather than leaving
            // a gap the user would read as a missing image.
            return <div key={index} className="pptx-picture" aria-label="图片" />;
          }
          if (shape.kind === 'table' && shape.table) {
            return (
              <table key={index} className="pptx-table">
                <tbody>
                  {shape.table.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cellText, cellIndex) => (
                        <td key={cellIndex}>{cellText}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          }
          return (
            <ul key={index} className="pptx-text">
              {shape.paragraphs.map((paragraph, paragraphIndex) => (
                <li
                  key={paragraphIndex}
                  // The outline depth is the one piece of layout worth keeping:
                  // it carries the deck's structure, which flattening would lose.
                  style={{ paddingLeft: `${paragraph.level * 14}px` }}
                >{paragraph.text}</li>
              ))}
            </ul>
          );
        })}
      </div>

      {showNotes && slide.notes && (
        <footer className="pptx-notes">
          <span className="pptx-notes-label">备注</span>
          {slide.notes.split('\n').map((line, index) => <p key={index}>{line}</p>)}
        </footer>
      )}
    </section>
  );
}
