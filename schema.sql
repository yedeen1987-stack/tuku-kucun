-- 拿货小程序 · D1 表结构
-- 设计前提：款号和色号【不是】固定主数据。新款随时进系统，
-- 所以这里没有 product/style 主表，款号色号都是拣货单上的自由文本，
-- 输入时用历史记录做自动补全（见 worker.js 的 suggestions）。

CREATE TABLE IF NOT EXISTS app_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'picker',      -- owner = 你；picker = 仓库工人
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES app_user(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);

-- 拣货单
CREATE TABLE IF NOT EXISTS picking_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,                -- 001、002…… 工人看到的单号
  customer_label TEXT NOT NULL,             -- 客户代号，例如「客户A」。不要写全名。
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',     -- draft=编辑中 / sent=已发给工人 / done=已完成 / cancelled=已取消
  external_uuid TEXT UNIQUE,                -- 本地系统推来的单据 id，用来防重复导入
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_list_status ON picking_list(status, id DESC);

-- 拣货单上的一项。style / color / floor / spot 全是自由文本，不做外键。
CREATE TABLE IF NOT EXISTS picking_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL,
  style TEXT NOT NULL DEFAULT '',           -- 款号，可以留空（只有照片也能拣）
  color TEXT NOT NULL DEFAULT '',           -- 色号 / 颜色，自由文本
  qty REAL NOT NULL DEFAULT 1,              -- 要几卷
  floor TEXT NOT NULL DEFAULT '',           -- 楼层，工人页按这个分组
  spot TEXT NOT NULL DEFAULT '',            -- 左 / 右 / 货架号，自由文本
  note TEXT NOT NULL DEFAULT '',
  photo_key TEXT NOT NULL DEFAULT '',       -- R2 对象 key；走鉴权路由 /media/，不公开
  taken_qty REAL NOT NULL DEFAULT 0,        -- 已拿几卷。由 picking_event 推出来的当前值。
  taken_at TEXT,
  taken_by INTEGER,
  item_uuid TEXT,                           -- 本地生成的条目 id，回执靠它对回本地记录
  done INTEGER NOT NULL DEFAULT 0,          -- 工人按了「完成」。拿齐和缺货都走这一个按钮：
  done_at TEXT,                             --   taken_qty >= qty 是拿齐
  done_by INTEGER,                          --   taken_qty <  qty 是缺货，差额 = qty - taken_qty
  -- 以后要做米数时在这里加 meters_json，不用改现有列
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(list_id) REFERENCES picking_list(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_item_list ON picking_item(list_id, sort_order, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_uuid ON picking_item(item_uuid);

-- 只追加的操作流水。工人每次点「已拿 / 撤销」写一条。
-- client_uuid 是手机端生成的，唯一约束 = 断网重发不会重复记账。
-- 以后接销售软件的 stock_movement，直接读这张表就行。
CREATE TABLE IF NOT EXISTS picking_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  list_id INTEGER NOT NULL,
  action TEXT NOT NULL,                     -- taken / untaken
  qty REAL NOT NULL DEFAULT 0,              -- 这次操作之后的累计已拿数
  user_id INTEGER,
  client_uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY(item_id) REFERENCES picking_item(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_event_item ON picking_event(item_id, id);
CREATE INDEX IF NOT EXISTS idx_event_list ON picking_event(list_id, id DESC);
