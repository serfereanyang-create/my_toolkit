import type { EditorSection, Evidence, Paper } from '../../types/paperApp';
import { EvidenceEditor } from './EvidenceEditor';
import { PaperMetadata } from './PaperMetadata';
import { ReadingNotes } from './ReadingNotes';

export type PaperWorkspaceProps = {
  paper: Paper;
  editorSection: EditorSection;
  onSectionChange: (section: EditorSection) => void;
  onPaperChange: (patch: Partial<Paper>) => void;
  onAddEvidence: () => void;
  onUpdateEvidence: (id: string, patch: Partial<Evidence>) => void;
  onRemoveEvidence: (id: string) => void;
};

export function PaperWorkspace({
  paper,
  editorSection,
  onSectionChange,
  onPaperChange,
  onAddEvidence,
  onUpdateEvidence,
  onRemoveEvidence,
}: PaperWorkspaceProps) {
  return (
    <main className="paper-editor">
      <div className="document-page">
        <PaperMetadata paper={paper} onChange={onPaperChange} />

        <div className="document-nav">
          <button
            type="button"
            className={editorSection === 'overview' ? 'active' : ''}
            onClick={() => onSectionChange('overview')}
          >
            概览
          </button>
          <button
            type="button"
            className={editorSection === 'notes' ? 'active' : ''}
            onClick={() => onSectionChange('notes')}
          >
            笔记
          </button>
          <button
            type="button"
            className={editorSection === 'evidence' ? 'active' : ''}
            onClick={() => onSectionChange('evidence')}
          >
            证据 ({paper.evidence.length})
          </button>
        </div>

        {editorSection === 'evidence' ? (
          <EvidenceEditor
            evidence={paper.evidence}
            onAdd={onAddEvidence}
            onUpdate={onUpdateEvidence}
            onRemove={onRemoveEvidence}
          />
        ) : (
          <ReadingNotes
            paper={paper}
            section={editorSection}
            onChange={onPaperChange}
          />
        )}
      </div>
    </main>
  );
}
