import { useRef, useState } from 'react';
import { Pencil, X } from 'lucide-react';
import type { AppAction } from '../../lib/state';
import { desktop } from '../../lib/ipc';

// Bug-14 fix: InlineEditBar used to depend on monaco-editor for cursor/selection
// tracking via editor.onDidChangeCursorSelection. Since the Monaco editor was
// removed from the app, this component is now a no-op stub that stays hidden.
// The monaco import and the Props.editor field are removed; the component
// renders nothing until the editor is re-introduced.

type Props = {
  filePath?: string;
  dispatch: React.Dispatch<AppAction>;
};

export function InlineEditBar({ filePath, dispatch }: Props) {
  const [instruction, setInstruction] = useState('');
  const [visible] = useState(false);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // No editor → bar is permanently hidden.
  if (!visible) return null;

  async function submit() {
    if (!instruction.trim() || !filePath) return;
    setRunning(true);
    try {
      const original = await desktop.fs.read(filePath);
      dispatch({
        type: 'diff/queue',
        diff: {
          id: `inline-${crypto.randomUUID()}`,
          path: filePath,
          originalContent: original,
          modifiedContent: original,
          status: 'pending',
        },
      });
      setInstruction('');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="inline-edit-bar" onMouseDown={(e) => e.stopPropagation()}>
      <Pencil size={13} className="inline-edit-icon" />
      <input
        ref={inputRef}
        className="inline-edit-input"
        placeholder="AI 改写选中代码…"
        value={instruction}
        autoFocus
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
        }}
        disabled={running}
      />
      <button className="inline-edit-submit" disabled={running || !instruction.trim()} onClick={() => void submit()}>
        {running ? '…' : '改写'}
      </button>
      <button className="inline-edit-close" onClick={() => void 0}><X size={12} /></button>
    </div>
  );
}
