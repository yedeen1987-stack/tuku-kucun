-- 货位：绑定「款号」，不绑色号、不绑单张图片。
-- Worker 的 ensureSchema 会自动执行同样的建表，这个文件是给你想提前手工建时用的。
-- 只新增，不删除、不重建、不清空任何现有数据。
--   npx wrangler d1 execute textil134-stock-marker --remote --file=migrations/0005_style_location.sql

CREATE TABLE IF NOT EXISTS style_location (
  code TEXT PRIMARY KEY COLLATE NOCASE,
  floor TEXT NOT NULL DEFAULT '',
  side TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS style_location_change (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL COLLATE NOCASE,
  old_floor TEXT NOT NULL DEFAULT '',
  old_side TEXT NOT NULL DEFAULT '',
  new_floor TEXT NOT NULL DEFAULT '',
  new_side TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL,
  changed_by INTEGER
);

CREATE INDEX IF NOT EXISTS idx_location_change_code ON style_location_change(code, id DESC);
