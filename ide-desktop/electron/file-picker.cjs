'use strict';

function normalizeFilePickerOptions(options) {
  const input = options && typeof options === 'object' ? options : {};
  const title = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim().slice(0, 120)
    : '选择文件';
  const filters = [];

  if (Array.isArray(input.filters)) {
    for (const entry of input.filters.slice(0, 8)) {
      if (!entry || typeof entry !== 'object') continue;
      const name = typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim().slice(0, 60)
        : '文件';
      const extensions = Array.isArray(entry.extensions)
        ? entry.extensions
            .filter((extension) => typeof extension === 'string')
            .map((extension) => extension.replace(/^\./, '').trim().toLowerCase())
            .filter((extension) => /^[a-z0-9]{1,10}$/.test(extension))
            .slice(0, 24)
        : [];
      if (extensions.length > 0) filters.push({ name, extensions });
    }
  }

  return {
    title,
    filters: filters.length > 0 ? filters : undefined,
  };
}

async function pickWorkspaceFile({ dialog, owner, root, options, stat }) {
  const normalized = normalizeFilePickerOptions(options);
  const picked = await dialog.showOpenDialog(owner, {
    title: normalized.title,
    properties: ['openFile'],
    filters: normalized.filters,
    defaultPath: root || undefined,
  });
  if (picked.canceled || !Array.isArray(picked.filePaths) || picked.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }

  const source = picked.filePaths[0];
  const fileStat = await stat(source).catch(() => null);
  if (!fileStat || !fileStat.isFile()) return { ok: false, error: '无法读取所选文件' };
  if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
    return { ok: false, error: '无法读取所选文件大小' };
  }
  return { ok: true, path: source, size: fileStat.size };
}

module.exports = { normalizeFilePickerOptions, pickWorkspaceFile };
