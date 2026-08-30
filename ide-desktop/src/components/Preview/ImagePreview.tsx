import React, { useEffect, useRef } from 'react';
import type { PreviewFileDescriptor, PreviewTab } from '../../types';

type Props = { tab: PreviewTab };

export function ImagePreview({ tab }: Props) {
  const desc = tab.descriptor as PreviewFileDescriptor;
  const src = `yoycode-preview://${desc.token}/${encodeURIComponent(desc.relativePath)}`;

  return (
    <div
      className="image-preview-container"
      style={{ '--preview-zoom': tab.fitWidth ? 'fit' : String(tab.zoom) } as React.CSSProperties}
    >
      <div className="image-preview-checkerboard">
        <img
          src={src}
          alt={tab.title}
          className={`image-preview-img ${tab.fitWidth ? 'fit-width' : ''}`}
          style={tab.fitWidth ? {} : { transform: `scale(${tab.zoom})`, transformOrigin: 'top center' }}
          draggable={false}
        />
      </div>
      {desc.size > 0 && (
        <div className="image-preview-info" aria-live="polite">
          {desc.name} · {formatSize(desc.size)}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
