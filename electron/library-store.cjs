const { getDb } = require('./db.cjs');
const { requireUserId } = require('./auth.cjs');

function loadPapers() {
  const userId = requireUserId();
  const rows = getDb().prepare(
    'SELECT payload FROM papers WHERE user_id = ? ORDER BY updated_at DESC',
  ).all(userId);
  return rows.map((row) => JSON.parse(row.payload));
}

function savePapers(papers) {
  const userId = requireUserId();
  const db = getDb();
  const list = Array.isArray(papers) ? papers : [];
  if (list.some((paper) => !paper || typeof paper.id !== 'string' || !paper.id.trim())) {
    throw new Error('论文记录缺少有效 id');
  }
  const upsert = db.prepare(
    `INSERT INTO papers (id, user_id, payload, title, year, status, updated_at)
     VALUES (@id, @userId, @payload, @title, @year, @status, @updatedAt)
     ON CONFLICT(user_id, id) DO UPDATE SET
       payload = excluded.payload,
       title = excluded.title,
       year = excluded.year,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  );

  const save = db.transaction((items) => {
    const updatedAt = new Date().toISOString();
    for (const paper of items) {
      upsert.run({
        id: paper.id,
        userId,
        payload: JSON.stringify(paper),
        title: paper.title || '',
        year: paper.year || '',
        status: paper.status || '',
        updatedAt,
      });
    }

    if (items.length === 0) {
      db.prepare('DELETE FROM papers WHERE user_id = ?').run(userId);
      return;
    }

    const placeholders = items.map(() => '?').join(',');
    db.prepare(`DELETE FROM papers WHERE user_id = ? AND id NOT IN (${placeholders})`)
      .run(userId, ...items.map((paper) => paper.id));
  });

  save(list);
}

module.exports = { loadPapers, savePapers };
