import { ConfirmDialog } from './ConfirmDialog';
import type { SaveConflict } from '../lib/useEditorSave';

export function SaveConflictDialog({ conflict, busy, onKeep, onReload, onOverwrite }: {
  conflict: SaveConflict | null;
  busy: boolean;
  onKeep: () => void;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  return <ConfirmDialog open={conflict !== null} title="文件已被外部修改" busy={busy}
    message={<><span className="save-conflict-path">{conflict?.path}</span>磁盘中的文件已更新，当前编辑尚未保存。请选择要保留的版本。</>}
    confirmLabel={busy ? '处理中…' : '覆盖并保存'} cancelLabel="保留编辑" danger
    secondaryAction={{ label: '加载磁盘版本', onClick: onReload }} onConfirm={onOverwrite} onCancel={onKeep} />;
}
