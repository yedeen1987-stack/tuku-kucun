// 拿货小程序 · Cloudflare Worker
// 你（owner）在电脑上建拣货单，仓库工人（picker）在手机上按楼层拣货、点已拿。
//
// 设计前提：款号 / 色号 / 货位都不是固定主数据，随时会有新的。
// 所以全部按自由文本存，输入时用历史值做自动补全，而不是从主表里选。

const enc = new TextEncoder();
const now = () => new Date().toISOString();
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {status, headers: {'Content-Type':'application/json; charset=utf-8', ...headers}});
const response = (body, status = 200, headers = {}) =>
  new Response(body, {status, headers: {'Content-Type':'text/html; charset=utf-8', ...headers}});
const redirect = (location, headers = {}) => new Response(null, {status: 302, headers: {Location: location, ...headers}});

const all = async (env, sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).all()).results || [];
const first = async (env, sql, ...binds) => await env.DB.prepare(sql).bind(...binds).first();
const run = async (env, sql, ...binds) => await env.DB.prepare(sql).bind(...binds).run();

// ---------- 文本清洗 ----------
// 款号统一大写去空格，方便和销售软件对照；但【不】做格式校验，
// 因为新款号格式可能和现有规则不一样，拦下来反而耽误干活。
const cleanStyle = (value) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 40);
const cleanText = (value, max = 80) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const cleanQty = (value) => {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? Math.round(number * 1000) / 1000 : 1;
};

// ---------- 密码与会话 ----------
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret || '')), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(String(value)));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function passwordHash(password, salt) {
  salt = salt || [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2,'0')).join('');
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash:'SHA-256'}, key, 256);
  const hex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2,'0')).join('');
  return `pbkdf2$100000$${salt}$${hex}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const candidate = enc.encode(await passwordHash(password, parts[2]));
  const expected = enc.encode(stored);
  return candidate.length === expected.length && crypto.subtle.timingSafeEqual(candidate, expected);
}

const randomId = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2,'0')).join('');
const SESSION_DAYS = 30;

async function createSession(env, userId) {
  const id = randomId(), csrf = randomId();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await run(env, 'INSERT INTO session(id,user_id,csrf,created_at,expires_at) VALUES(?,?,?,?,?)', id, userId, csrf, now(), expires);
  return {id, csrf};
}

const sessionCookie = (session) =>
  `sid=${session.id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
const clearCookie = 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

async function currentUser(request, env) {
  const sid = readCookie(request, 'sid');
  if (!sid) return {};
  const row = await first(env,
    `SELECT s.id sid, s.csrf, s.expires_at, u.id, u.username, u.display_name, u.role, u.is_active
     FROM session s JOIN app_user u ON u.id = s.user_id WHERE s.id = ?`, sid);
  if (!row || !row.is_active) return {};
  if (row.expires_at < now()) { await run(env, 'DELETE FROM session WHERE id=?', sid); return {}; }
  return {user: {id: row.id, username: row.username, display_name: row.display_name, role: row.role},
          session: {id: row.sid, csrf: row.csrf}};
}

const validCsrf = (session, token) => Boolean(session && token && token === session.csrf);

// ---------- 建表 ----------
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS app_user (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'picker',
      is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id)`,
    `CREATE TABLE IF NOT EXISTS picking_list (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
      customer_label TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
      external_uuid TEXT UNIQUE, created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_list_status ON picking_list(status, id DESC)`,
    `CREATE TABLE IF NOT EXISTS picking_item (id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL,
      style TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', qty REAL NOT NULL DEFAULT 1,
      floor TEXT NOT NULL DEFAULT '', spot TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
      photo_key TEXT NOT NULL DEFAULT '', taken_qty REAL NOT NULL DEFAULT 0, taken_at TEXT, taken_by INTEGER,
      item_uuid TEXT, done INTEGER NOT NULL DEFAULT 0, done_at TEXT, done_by INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_item_uuid ON picking_item(item_uuid)`,
    `CREATE INDEX IF NOT EXISTS idx_item_list ON picking_item(list_id, sort_order, id)`,
    `CREATE TABLE IF NOT EXISTS picking_event (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
      list_id INTEGER NOT NULL, action TEXT NOT NULL, qty REAL NOT NULL DEFAULT 0, user_id INTEGER,
      client_uuid TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_event_item ON picking_event(item_id, id)`,
    `CREATE INDEX IF NOT EXISTS idx_event_list ON picking_event(list_id, id DESC)`
  ];
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
  // 增量列：老库升级用，列已存在会报错，忽略。
  // done = 工人按了「完成」。拿齐和缺货都走这一个按钮：
  // taken_qty >= qty 就是拿齐，taken_qty < qty 就是缺货，差额 = qty - taken_qty。
  // item_uuid 是本地生成的，回执靠它对回本地的记录。
  for (const sql of [
    'ALTER TABLE picking_item ADD COLUMN item_uuid TEXT',
    'ALTER TABLE picking_item ADD COLUMN done INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE picking_item ADD COLUMN done_at TEXT',
    'ALTER TABLE picking_item ADD COLUMN done_by INTEGER',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_item_uuid ON picking_item(item_uuid)'
  ]) {
    try { await env.DB.prepare(sql).run(); } catch { /* 列已存在 */ }
  }
  schemaReady = true;
}

// ---------- 页面外壳 ----------
function base({title, body, csrf = '', script = '', lang = 'zh-CN', bodyClass = ''}) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111418">
<title>${esc(title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/app.css"></head>
<body class="${bodyClass}" data-csrf="${esc(csrf)}">${body}
${script ? `<script src="/${script}" defer></script>` : ''}
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(function(){});</script>
</body></html>`;
}

const STATUS_TEXT = {draft:'编辑中', sent:'已发出', done:'已完成', cancelled:'已取消'};

// ---------- 登录 / 首次设置 ----------
function loginPage(error = '') {
  return response(base({
    title: '登录 · 拿货',
    lang: 'zh-CN',
    body: `<main class="auth">
  <form class="card auth-card" method="post" action="/login">
    <h1>拿货</h1>
    <p class="muted">Controle de separação</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <label>账号 / Usuário<input name="username" autocomplete="username" autocapitalize="none" required autofocus></label>
    <label>密码 / Senha<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn btn-primary btn-lg">进入 / Entrar</button>
  </form>
</main>`}));
}

function setupPage(error = '') {
  return response(base({
    title: '首次设置 · 拿货',
    body: `<main class="auth">
  <form class="card auth-card" method="post" action="/setup">
    <h1>首次设置</h1>
    <p class="muted">系统里还没有账号，先建一个你自己的管理员账号。这个页面在建好之后会自动关闭。</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <label>你的名字<input name="display_name" required autofocus></label>
    <label>登录账号<input name="username" pattern="[a-z0-9_.\\-]{3,40}" autocapitalize="none" required>
      <small>小写字母、数字、. _ -，3到40位</small></label>
    <label>密码<input name="password" type="password" minlength="8" required><small>至少8位</small></label>
    <button class="btn btn-primary btn-lg">创建管理员</button>
  </form>
</main>`}));
}

// ---------- 进度计算 ----------
function progressOf(items) {
  const total = items.length;
  const done = items.filter((item) => item.done).length;
  return {total, done, allDone: total > 0 && done === total};
}

// ---------- 你（owner）：拣货单总览 ----------
async function ownerHome(env, user, session) {
  const lists = await all(env,
    `SELECT l.*, COUNT(i.id) total, SUM(CASE WHEN i.done THEN 1 ELSE 0 END) done,
            SUM(CASE WHEN i.done AND i.taken_qty < i.qty THEN 1 ELSE 0 END) short
     FROM picking_list l LEFT JOIN picking_item i ON i.list_id = l.id
     WHERE l.status != 'cancelled' GROUP BY l.id ORDER BY
       CASE l.status WHEN 'sent' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, l.id DESC LIMIT 100`);

  const rows = lists.map((list) => {
    const total = Number(list.total) || 0, done = Number(list.done) || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<a class="list-row" href="/list/${list.id}">
      <div class="list-row-main">
        <strong>${esc(list.customer_label)}</strong>
        <small>拣货单 ${esc(list.code)} · ${STATUS_TEXT[list.status] || list.status}${
          Number(list.short) ? ` · <b class="short-flag">缺货 ${Number(list.short)}</b>` : ''}</small>
      </div>
      <div class="list-row-progress">
        <span class="count ${done === total && total ? 'is-done' : ''}">${done}/${total}</span>
        <span class="bar"><i style="width:${pct}%"></i></span>
      </div>
    </a>`;
  }).join('') || '<p class="empty">还没有拣货单。点上面的「新建拣货单」开始。</p>';

  return response(base({
    title: '拿货 · 拣货单',
    csrf: session.csrf,
    script: 'owner.js',
    body: `<header class="topbar">
  <span class="wordmark">拿货</span>
  <nav>
    <a href="/w">工人视图</a>
    <a href="/users">账号</a>
    <form method="post" action="/logout"><input type="hidden" name="csrf_token" value="${session.csrf}"><button class="linkbtn">退出</button></form>
  </nav>
</header>
<main class="wrap">
  <div class="page-head">
    <h1>拣货单</h1>
    <button class="btn btn-primary" id="new-list">＋ 新建拣货单</button>
  </div>
  <div class="list-rows">${rows}</div>
</main>
<dialog id="new-list-dialog" class="dialog">
  <form method="post" action="/api/lists">
    <h2>新建拣货单</h2>
    <input type="hidden" name="csrf_token" value="${session.csrf}">
    <label>客户代号<input name="customer_label" required maxlength="40" placeholder="例如 客户A" autofocus>
      <small>工人会看到这个。建议用代号，不要写客户全名。</small></label>
    <label>备注（可选）<input name="note" maxlength="200"></label>
    <div class="dialog-actions">
      <button type="button" class="btn" data-close>取消</button>
      <button class="btn btn-primary">创建</button>
    </div>
  </form>
</dialog>`}));
}

// ---------- 自动补全候选 ----------
// 没有款号主表，候选全部来自「以前拣过什么」。用得越多，输入越快。
async function suggestions(env) {
  const [styles, colors, floors, spots] = await Promise.all([
    all(env, `SELECT style value, COUNT(*) n FROM picking_item WHERE style != '' GROUP BY style ORDER BY n DESC, style LIMIT 300`),
    all(env, `SELECT color value, COUNT(*) n FROM picking_item WHERE color != '' GROUP BY color ORDER BY n DESC, color LIMIT 100`),
    all(env, `SELECT floor value, COUNT(*) n FROM picking_item WHERE floor != '' GROUP BY floor ORDER BY n DESC, floor LIMIT 50`),
    all(env, `SELECT spot  value, COUNT(*) n FROM picking_item WHERE spot  != '' GROUP BY spot  ORDER BY n DESC, spot  LIMIT 50`)
  ]);
  return {styles, colors, floors, spots};
}

const datalist = (id, rows) =>
  `<datalist id="${id}">${rows.map((row) => `<option value="${esc(row.value)}"></option>`).join('')}</datalist>`;

// ---------- 你（owner）：单张拣货单 ----------
async function listPage(env, user, session, listId) {
  const list = await first(env, 'SELECT * FROM picking_list WHERE id=?', listId);
  if (!list) return response('<main class="wrap"><p class="empty">拣货单不存在。</p><a href="/">返回</a></main>', 404);

  const items = await all(env, 'SELECT * FROM picking_item WHERE list_id=? ORDER BY sort_order, id', listId);
  const hints = await suggestions(env);
  const progress = progressOf(items);
  const shortCount = items.filter((item) => item.done && item.taken_qty < item.qty).length;

  const itemRows = items.map((item) => {
    const done = !!item.done;
    const short = done && item.taken_qty < item.qty;
    const place = [item.floor, item.spot].filter(Boolean).join(' · ');
    return `<article class="item-row ${short ? 'is-short' : done ? 'is-done' : ''}">
      ${item.photo_key
        ? `<a class="item-thumb" href="/media/${encodeURIComponent(item.photo_key)}" target="_blank" rel="noopener">
             <img src="/media/${encodeURIComponent(item.photo_key)}" alt="" loading="lazy"></a>`
        : '<span class="item-thumb item-thumb--empty">无图</span>'}
      <div class="item-main">
        <strong>${esc(item.style || '（未填款号）')}${item.color ? ` · ${esc(item.color)}` : ''}</strong>
        <small>${place ? esc(place) : '<em>未填货位</em>'}${item.note ? ` · ${esc(item.note)}` : ''}</small>
      </div>
      <div class="item-qty" data-item="${item.id}" data-taken="${item.taken_qty}">
        <button type="button" class="qty-btn" data-qty-step="-1" aria-label="少一卷">−</button>
        <input class="qty-input" inputmode="decimal" value="${item.qty}" aria-label="卷数">
        <button type="button" class="qty-btn" data-qty-step="1" aria-label="多一卷">＋</button>
        <span class="qty-unit">卷</span>
      </div>
      <span class="item-state" data-state-for="${item.id}">${
        short ? `缺 ${Math.round((item.qty - item.taken_qty) * 1000) / 1000}`
        : done ? '已拿' : `${item.taken_qty}/${item.qty}`}</span>
      <form method="post" action="/api/items/${item.id}/delete" class="item-del"
            onsubmit="return confirm('删除这一项？')">
        <input type="hidden" name="csrf_token" value="${session.csrf}">
        <button class="linkbtn" title="删除">×</button>
      </form>
    </article>`;
  }).join('') || '<p class="empty">还没有条目。用下面的表单加第一项。</p>';

  const sendable = list.status === 'draft' && items.length > 0;

  return response(base({
    title: `${list.customer_label} · 拣货单 ${list.code}`,
    csrf: session.csrf,
    script: 'owner.js',
    body: `<header class="topbar">
  <a class="wordmark" href="/">← 拣货单</a>
  <nav><span class="badge badge--${list.status}">${STATUS_TEXT[list.status] || list.status}</span></nav>
</header>
<main class="wrap">
  <div class="page-head">
    <h1>${esc(list.customer_label)}</h1>
    <span class="muted">单号 ${esc(list.code)} · 完成 <b id="list-done">${progress.done}</b>/${progress.total}${
      shortCount ? ` · <b class="short-flag">缺货 ${shortCount} 项</b>` : ''}</span>
  </div>
  ${list.note ? `<p class="note-line">${esc(list.note)}</p>` : ''}

  <div class="item-rows">${itemRows}</div>

  ${list.status === 'draft' ? `
  <form class="card add-form" method="post" action="/api/lists/${list.id}/items" enctype="multipart/form-data">
    <h2>加一项</h2>
    <input type="hidden" name="csrf_token" value="${session.csrf}">
    <div class="grid">
      <label>款号<input name="style" list="dl-styles" autocapitalize="characters" autocomplete="off" placeholder="例如 YXS10237">
        <small>新款号直接打，不用先登记</small></label>
      <label>色号 / 颜色<input name="color" list="dl-colors" autocomplete="off" placeholder="例如 3#"></label>
      <label>卷数<input name="qty" inputmode="decimal" value="1" required></label>
      <label>楼层<input name="floor" list="dl-floors" autocomplete="off" placeholder="例如 1楼"><small>工人页按楼层分组</small></label>
      <label>位置<input name="spot" list="dl-spots" autocomplete="off" placeholder="例如 左 / A03"></label>
      <label>备注<input name="note" maxlength="120" autocomplete="off"></label>
    </div>
    <label class="file-label">实拍照片（建议加，工人靠它认布）
      <input type="file" name="photo" accept="image/*" capture="environment"></label>
    <button class="btn btn-primary btn-lg">加入拣货单</button>
  </form>` : ''}

  <div class="page-actions">
    ${sendable ? `<form method="post" action="/api/lists/${list.id}/status">
      <input type="hidden" name="csrf_token" value="${session.csrf}">
      <input type="hidden" name="status" value="sent">
      <button class="btn btn-primary btn-lg">发送拣货 → 工人手机</button></form>` : ''}
    ${list.status === 'sent' ? `<form method="post" action="/api/lists/${list.id}/status">
      <input type="hidden" name="csrf_token" value="${session.csrf}">
      <input type="hidden" name="status" value="draft">
      <button class="btn">撤回，继续编辑</button></form>
      <form method="post" action="/api/lists/${list.id}/status">
      <input type="hidden" name="csrf_token" value="${session.csrf}">
      <input type="hidden" name="status" value="done">
      <button class="btn">标记完成</button></form>` : ''}
    <form method="post" action="/api/lists/${list.id}/status" onsubmit="return confirm('取消这张拣货单？')">
      <input type="hidden" name="csrf_token" value="${session.csrf}">
      <input type="hidden" name="status" value="cancelled">
      <button class="linkbtn danger">取消这张单</button></form>
  </div>
</main>
${datalist('dl-styles', hints.styles)}${datalist('dl-colors', hints.colors)}
${datalist('dl-floors', hints.floors)}${datalist('dl-spots', hints.spots)}`}));
}

// ---------- 账号管理 ----------
async function usersPage(env, session, error = '') {
  const users = await all(env, 'SELECT id,username,display_name,role,is_active FROM app_user ORDER BY role, username');
  const rows = users.map((user) => `<article class="user-row ${user.is_active ? '' : 'is-off'}">
    <div><strong>${esc(user.display_name || user.username)}</strong>
      <small>${esc(user.username)} · ${user.role === 'owner' ? '管理员' : '仓库工人'}</small></div>
    ${user.role === 'picker' ? `<form method="post" action="/users">
      <input type="hidden" name="csrf_token" value="${session.csrf}">
      <input type="hidden" name="action" value="toggle"><input type="hidden" name="id" value="${user.id}">
      <button class="btn btn-sm">${user.is_active ? '停用' : '恢复'}</button></form>
      <form method="post" action="/users" class="pw-form">
      <input type="hidden" name="csrf_token" value="${session.csrf}">
      <input type="hidden" name="action" value="password"><input type="hidden" name="id" value="${user.id}">
      <input name="password" type="password" minlength="6" placeholder="新密码" required>
      <button class="btn btn-sm">改密码</button></form>` : '<span class="muted">你自己</span>'}
  </article>`).join('');

  return response(base({
    title: '账号 · 拿货',
    csrf: session.csrf,
    body: `<header class="topbar"><a class="wordmark" href="/">← 拣货单</a></header>
<main class="wrap">
  <h1>账号</h1>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <form class="card" method="post" action="/users">
    <h2>加一个工人账号</h2>
    <input type="hidden" name="csrf_token" value="${session.csrf}">
    <input type="hidden" name="action" value="create">
    <div class="grid">
      <label>名字<input name="display_name" required maxlength="40"></label>
      <label>登录账号<input name="username" pattern="[a-z0-9_.\\-]{3,40}" autocapitalize="none" required></label>
      <label>初始密码<input name="password" type="password" minlength="6" required></label>
    </div>
    <button class="btn btn-primary">创建</button>
    <p class="muted">工人只能看到发给他们的拣货单，看不到价格、客户全名，也不能改单。</p>
  </form>
  <div class="user-rows">${rows}</div>
</main>`}));
}

// ---------- 工人手机端（葡语） ----------
async function pickerHome(env, user, session) {
  const lists = await all(env,
    `SELECT l.id, l.code, l.customer_label, COUNT(i.id) total,
            SUM(CASE WHEN i.done THEN 1 ELSE 0 END) done,
            SUM(CASE WHEN i.done AND i.taken_qty < i.qty THEN 1 ELSE 0 END) short
     FROM picking_list l LEFT JOIN picking_item i ON i.list_id = l.id
     WHERE l.status = 'sent' GROUP BY l.id ORDER BY l.id DESC`);

  const rows = lists.map((list) => {
    const total = Number(list.total) || 0, done = Number(list.done) || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<a class="list-row" href="/w/${list.id}">
      <div class="list-row-main"><strong>${esc(list.customer_label)}</strong><small>Nº ${esc(list.code)}${
        Number(list.short) ? ` · falta ${Number(list.short)}` : ''}</small></div>
      <div class="list-row-progress">
        <span class="count ${done === total && total ? 'is-done' : ''}">${done}/${total}</span>
        <span class="bar"><i style="width:${pct}%"></i></span>
      </div></a>`;
  }).join('') || '<p class="empty">Nenhuma lista no momento.</p>';

  return response(base({
    title: 'Separação',
    lang: 'pt-BR',
    csrf: session.csrf,
    bodyClass: 'picker',
    body: `<header class="topbar">
  <span class="wordmark">Separação</span>
  <nav>${user.role === 'owner' ? '<a href="/">Admin</a>' : ''}
    <form method="post" action="/logout"><input type="hidden" name="csrf_token" value="${session.csrf}"><button class="linkbtn">Sair</button></form>
  </nav></header>
<main class="wrap"><div class="list-rows">${rows}</div></main>`}));
}

async function pickerList(env, user, session, listId) {
  const list = await first(env, 'SELECT * FROM picking_list WHERE id=? AND status=?', listId, 'sent');
  if (!list) return response(base({lang:'pt-BR', title:'Separação',
    body:'<main class="wrap"><p class="empty">Esta lista não está disponível.</p><a class="btn" href="/w">Voltar</a></main>'}), 404);

  const items = await all(env, 'SELECT * FROM picking_item WHERE list_id=? ORDER BY floor, spot, sort_order, id', listId);

  // 按楼层分组：工人在仓库里是一层一层走的，不是一单一单走的。
  const groups = new Map();
  for (const item of items) {
    const key = item.floor || 'Sem andar';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const sections = [...groups.entries()].map(([floor, rows]) => {
    const doneCount = rows.filter((item) => item.done).length;
    const cards = rows.map((item) => {
      const done = !!item.done;
      const short = done && item.taken_qty < item.qty;
      const photo = item.photo_key ? `/media/${encodeURIComponent(item.photo_key)}` : '';
      // 款号可以是空的（无编号的款）：显示破折号，工人靠照片认
      const code = item.style ? esc(item.style) : '—';
      const gap = Math.round((item.qty - item.taken_qty) * 1000) / 1000;
      return `<article class="pick-card${done ? (short ? ' is-short' : ' is-done') : ''}"
        data-item="${item.id}" data-qty="${item.qty}" data-taken="${item.taken_qty}" data-done="${done ? 1 : 0}">
        ${photo
          ? `<button class="pick-photo" type="button" data-zoom="${esc(photo)}"><img src="${esc(photo)}" alt="" loading="lazy"></button>`
          : '<span class="pick-photo pick-photo--empty">sem foto</span>'}
        <div class="pick-body">
          <strong class="pick-code">${code}${item.color ? ` · ${esc(item.color)}` : ''}</strong>
          <span class="pick-place">${esc([item.floor, item.spot].filter(Boolean).join(' · ') || '—')}</span>
          ${item.note ? `<span class="pick-note">${esc(item.note)}</span>` : ''}
          <span class="pick-need">Precisa <b>${item.qty}</b> rolos</span>
        </div>
        <div class="pick-actions">
          <button class="btn btn-step" type="button" data-step="-1" aria-label="menos">−</button>
          <span class="pick-count"><b data-taken-label>${item.taken_qty}</b><i data-need>/${item.qty}</i></span>
          <button class="btn btn-step" type="button" data-step="1" aria-label="mais">+</button>
          <button class="btn btn-finish" type="button" data-finish>${done ? (short ? `Faltou ${gap}` : 'Pronto ✓') : 'Pronto'}</button>
        </div>
      </article>`;
    }).join('');

    return `<section class="floor-group">
      <h2 class="floor-head"><span>${esc(floor)}</span><small data-floor-count>${doneCount}/${rows.length}</small></h2>
      ${cards}</section>`;
  }).join('');

  const doneItems = items.filter((item) => item.done).length;
  const rollsNeed = Math.round(items.reduce((sum, item) => sum + item.qty, 0) * 1000) / 1000;
  const rollsGot = Math.round(items.reduce((sum, item) => sum + item.taken_qty, 0) * 1000) / 1000;

  return response(base({
    title: `${list.customer_label} · ${list.code}`,
    lang: 'pt-BR',
    csrf: session.csrf,
    script: 'picker.js',
    bodyClass: 'picker',
    body: `<header class="topbar">
  <a class="wordmark" href="/w">← ${esc(list.customer_label)}</a>
  <nav><span class="badge" id="sync-badge" data-state="ok">online</span></nav>
</header>
<main class="wrap">
  <p class="pick-progress">
    <span><b id="progress-items">${doneItems}</b> / ${items.length} modelos</span>
    <span><b id="progress-rolls">${rollsGot}</b> / ${rollsNeed} rolos</span>
  </p>
  ${sections || '<p class="empty">Lista vazia.</p>'}
</main>
<div class="zoom" id="zoom" hidden><img alt=""><button type="button" class="zoom-close" aria-label="fechar">×</button></div>
<div class="confirm" id="short-confirm" hidden>
  <div class="confirm-card">
    <strong id="short-title"></strong>
    <p id="short-text"></p>
    <div class="confirm-actions">
      <button type="button" class="btn" data-cancel>Voltar</button>
      <button type="button" class="btn btn-danger" data-ok></button>
    </div>
  </div>
</div>`}));
}

// ---------- 照片 ----------
const PHOTO_TYPES = {'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp'};
const MAX_PHOTO = 12 * 1024 * 1024;

async function storePhoto(env, listId, file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !file.size) return '';
  const ext = PHOTO_TYPES[file.type];
  if (!ext) throw new Error('照片格式只支持 JPG / PNG / WebP');
  if (file.size > MAX_PHOTO) throw new Error('照片太大，请压缩到 12MB 以内');
  const key = `list/${listId}/${randomId()}.${ext}`;
  await env.PHOTOS.put(key, await file.arrayBuffer(), {httpMetadata: {contentType: file.type}});
  return key;
}

// 注意：这条路由放在登录检查【之后】。实拍照片会暴露货架、堆放和库存量，
// 绝对不能像客户图库的 /media/ 那样公开。
async function serveMedia(env, key) {
  const object = await env.PHOTOS.get(key);
  if (!object) return new Response('Not found', {status: 404});
  return new Response(object.body, {headers: {
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'Cache-Control': 'private, max-age=31536000, immutable'
  }});
}

// ---------- 从库存图记读货位 ----------
// 加条目时如果没填楼层/位置，就去图库按款号查一次。
// 图库的 style_location 是货位的唯一真相源——这边只读，不存第二份。
// 图库连不上时不报错：让你手工填，别因为查货位失败就不让加条目。
let locationCache = null;

async function galleryLocations(env) {
  const base = String(env.GALLERY_URL || '').trim().replace(/\/$/, '');
  const token = String(env.GALLERY_TOKEN || '');
  if (!base || token.length < 24) return null;
  if (locationCache && Date.now() - locationCache.at < 60000) return locationCache.map;
  try {
    const res = await fetch(`${base}/api/style-locations`, {headers: {Authorization: `Bearer ${token}`}});
    if (!res.ok) return locationCache?.map || null;
    const body = await res.json();
    const map = new Map();
    for (const item of body?.items || []) {
      map.set(String(item.code || '').toUpperCase(), {floor: item.floor || '', side: item.side || ''});
    }
    locationCache = {at: Date.now(), map};
    return map;
  } catch { return locationCache?.map || null; }
}

// 返回 [楼层, 位置]：填了就用填的，没填才去图库查。
async function resolvePlace(env, style, floor, spot) {
  if (floor || spot || !style) return [floor, spot];
  const map = await galleryLocations(env);
  const hit = map?.get(style.toUpperCase());
  return hit ? [hit.floor, hit.side] : [floor, spot];
}

// ---------- 拣货单编号 ----------
async function nextListCode(env) {
  const row = await first(env, `SELECT code FROM picking_list WHERE code GLOB '[0-9]*' ORDER BY CAST(code AS INTEGER) DESC LIMIT 1`);
  return String((Number(row?.code) || 0) + 1).padStart(3, '0');
}

// ---------- 记录已拿 / 撤销 ----------
// 手机端离线时把操作排进队列，恢复网络后整批发过来。
// client_uuid 有唯一约束：同一条重发多少次都只会记一次账。
async function applyEvents(env, userId, events) {
  const applied = [];
  for (const event of Array.isArray(events) ? events.slice(0, 200) : []) {
    const itemId = Number(event?.item_id);
    const uuid = String(event?.client_uuid || '').slice(0, 64);
    // qty   = 改数量（点 − ＋）
    // done  = 按「完成」。拿齐和缺货是同一个动作，差额由 qty - taken_qty 算出来。
    // undone= 撤销完成，回到可继续拣的状态
    const action = ['done', 'undone', 'qty'].includes(event?.action) ? event.action : 'qty';
    if (!Number.isInteger(itemId) || !uuid) continue;

    const item = await first(env, 'SELECT id,list_id,qty,taken_qty,done FROM picking_item WHERE id=?', itemId);
    if (!item) continue;

    let taken = Number(event?.qty);
    if (!Number.isFinite(taken)) taken = item.taken_qty;
    taken = Math.max(0, Math.min(item.qty, Math.round(taken * 1000) / 1000));
    const done = action === 'done' ? 1 : action === 'undone' ? 0 : item.done;

    const stamp = now();
    const inserted = await run(env,
      `INSERT OR IGNORE INTO picking_event(item_id,list_id,action,qty,user_id,client_uuid,created_at)
       VALUES(?,?,?,?,?,?,?)`, itemId, item.list_id, action, taken, userId, uuid, stamp);

    if (inserted.meta?.changes) {
      await run(env,
        'UPDATE picking_item SET taken_qty=?, taken_at=?, taken_by=?, done=?, done_at=?, done_by=? WHERE id=?',
        taken, taken > 0 ? stamp : null, taken > 0 ? userId : null,
        done, done ? stamp : null, done ? userId : null, itemId);
    }
    const current = await first(env, 'SELECT taken_qty,qty,done FROM picking_item WHERE id=?', itemId);
    applied.push({item_id: itemId, client_uuid: uuid,
      taken_qty: current?.taken_qty ?? taken, done: current?.done ? 1 : 0,
      shortage: current?.done && current.taken_qty < current.qty
        ? Math.round((current.qty - current.taken_qty) * 1000) / 1000 : 0});
  }
  return applied;
}

// ---------- 回执：给本地主系统轮询 ----------
// 本地不开公网入口，所以是本地【主动来拿】，不是线上往本地推。
// since 传上次拿到的时间戳，只返回之后有变动的单，省流量。
async function receiptsApi(request, env, url) {
  const token = String(env.IMPORT_TOKEN || '');
  if (token.length < 24) return json({error: '导入接口未启用'}, 503);
  const given = enc.encode(String(request.headers.get('Authorization') || ''));
  const expected = enc.encode(`Bearer ${token}`);
  if (given.length !== expected.length || !crypto.subtle.timingSafeEqual(given, expected))
    return json({error: '无权限'}, 401);

  const since = String(url.searchParams.get('since') || '').slice(0, 40);
  const lists = await all(env,
    `SELECT l.id,l.code,l.customer_label,l.status,l.external_uuid,l.updated_at,
            MAX(COALESCE(i.done_at, i.taken_at, l.updated_at)) last_event
     FROM picking_list l LEFT JOIN picking_item i ON i.list_id = l.id
     WHERE l.external_uuid IS NOT NULL GROUP BY l.id
     HAVING ? = '' OR last_event > ? ORDER BY l.id`, since, since);

  const out = [];
  for (const list of lists) {
    const items = await all(env,
      `SELECT item_uuid,style,color,qty,taken_qty,done,done_at,floor,spot FROM picking_item
       WHERE list_id=? ORDER BY sort_order,id`, list.id);
    const rows = items.map(item => ({
      item_uuid: item.item_uuid || null,
      style_code: item.style || null,
      quantity_required: item.qty,
      quantity_picked: item.taken_qty,
      shortage: item.done && item.taken_qty < item.qty
        ? Math.round((item.qty - item.taken_qty) * 1000) / 1000 : 0,
      done: item.done ? true : false,
      done_at: item.done_at,
      floor_snapshot: item.floor, side_snapshot: item.spot
    }));
    out.push({
      order_uuid: list.external_uuid, code: list.code, customer_label: list.customer_label,
      status: list.status, last_event: list.last_event,
      items_total: rows.length, items_done: rows.filter(r => r.done).length,
      rolls_required: rows.reduce((sum, r) => sum + r.quantity_required, 0),
      rolls_picked: rows.reduce((sum, r) => sum + r.quantity_picked, 0),
      shortage_rolls: rows.reduce((sum, r) => sum + r.shortage, 0),
      all_done: rows.length > 0 && rows.every(r => r.done),
      items: rows
    });
  }
  return json({ok: true, now: now(), count: out.length, orders: out});
}

// ---------- 给以后的本地系统用的导入接口 ----------
// 本地识图确认完 → PUT /api/import 一整张拣货单。external_uuid 防重复导入。
async function importList(request, env) {
  const token = String(env.IMPORT_TOKEN || '');
  if (token.length < 24) return json({error: '导入接口未启用'}, 503);
  const given = enc.encode(String(request.headers.get('Authorization') || ''));
  const expected = enc.encode(`Bearer ${token}`);
  if (given.length !== expected.length || !crypto.subtle.timingSafeEqual(given, expected))
    return json({error: '无权限'}, 401);

  let body; try { body = await request.json(); } catch { return json({error: '格式错误'}, 400); }
  const uuid = String(body?.uuid || '').slice(0, 64);
  const customer = cleanText(body?.customer_label, 40);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 500) : null;
  if (!uuid || !customer || !items) return json({error: '缺少 uuid / customer_label / items'}, 400);

  const existing = await first(env, 'SELECT id,code FROM picking_list WHERE external_uuid=?', uuid);
  if (existing) return json({ok: true, duplicate: true, list_id: existing.id, code: existing.code});

  const stamp = now(), code = await nextListCode(env);
  const created = await run(env,
    `INSERT INTO picking_list(code,customer_label,note,status,external_uuid,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?)`, code, customer, cleanText(body?.note, 200), 'sent', uuid, stamp, stamp);
  const listId = created.meta.last_row_id;

  let order = 0;
  for (const item of items) {
    const style = cleanStyle(item?.style);
    const [floor, spot] = await resolvePlace(env, style,
      cleanText(item?.floor, 40), cleanText(item?.spot, 40));
    await run(env,
      `INSERT INTO picking_item(list_id,style,color,qty,floor,spot,note,photo_key,item_uuid,sort_order,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      listId, style, cleanText(item?.color, 40), cleanQty(item?.qty),
      floor, spot, cleanText(item?.note, 120),
      String(item?.photo_key || '').slice(0, 200),
      String(item?.uuid || '').slice(0, 64) || null, order++, stamp);
  }
  return json({ok: true, list_id: listId, code, count: items.length});
}

// ---------- 路由 ----------
const PUBLIC_ASSETS = ['/app.css', '/owner.js', '/picker.js', '/sw.js', '/manifest.webmanifest', '/icon.svg'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname, method = request.method.toUpperCase();
    try {
      if (PUBLIC_ASSETS.includes(path)) return env.ASSETS.fetch(request);
      await ensureSchema(env);

      // 本地系统推拣货单（自带 token，不走登录）
      if (path === '/api/import' && method === 'PUT') return importList(request, env);
      if (path === '/api/photos' && method === 'POST') return receivePhoto(request, env);
      if (path === '/api/receipts' && method === 'GET') return receiptsApi(request, env, url);

      const userCount = await first(env, 'SELECT COUNT(*) n FROM app_user');
      if (!userCount?.n) {
        if (path === '/setup' && method === 'GET') return setupPage();
        if (path === '/setup' && method === 'POST') {
          const form = await request.formData();
          const username = cleanText(form.get('username'), 40).toLowerCase();
          const password = String(form.get('password') || '');
          const display = cleanText(form.get('display_name'), 40);
          if (!/^[a-z0-9_.-]{3,40}$/.test(username) || password.length < 8 || !display)
            return setupPage('资料不正确：账号3-40位小写，密码至少8位，名字不能空。');
          await run(env, 'INSERT INTO app_user(username,password_hash,display_name,role,is_active,created_at) VALUES(?,?,?,?,?,?)',
            username, await passwordHash(password), display, 'owner', 1, now());
          const user = await first(env, 'SELECT id FROM app_user WHERE username=?', username);
          return redirect('/', {'Set-Cookie': sessionCookie(await createSession(env, user.id))});
        }
        return redirect('/setup');
      }

      if (path === '/login' && method === 'GET') {
        const auth = await currentUser(request, env);
        return auth.user ? redirect(auth.user.role === 'owner' ? '/' : '/w') : loginPage();
      }
      if (path === '/login' && method === 'POST') {
        const form = await request.formData();
        const username = cleanText(form.get('username'), 40).toLowerCase();
        const password = String(form.get('password') || '');
        const row = await first(env, 'SELECT * FROM app_user WHERE username=? AND is_active=1', username);
        if (!row || !(await verifyPassword(password, row.password_hash)))
          return loginPage('账号或密码错误 / Usuário ou senha incorretos');
        return redirect(row.role === 'owner' ? '/' : '/w',
          {'Set-Cookie': sessionCookie(await createSession(env, row.id))});
      }

      // ↓↓↓ 这条线以下全部需要登录 ↓↓↓
      const auth = await currentUser(request, env);
      if (!auth.user) return method === 'GET' ? redirect('/login') : json({error: '请重新登录'}, 401);
      const {user, session} = auth;
      const owner = user.role === 'owner';

      // 写操作一律校验 CSRF
      let form = null;
      if (method === 'POST' && !path.startsWith('/api/events')) {
        form = await request.formData();
        if (!validCsrf(session, String(form.get('csrf_token') || '')))
          return method === 'POST' && path.startsWith('/api/') ? json({error: '请求已过期'}, 403) : response('请求已过期，请刷新页面重试', 403);
      }

      if (path === '/logout' && method === 'POST') {
        await run(env, 'DELETE FROM session WHERE id=?', session.id);
        return redirect('/login', {'Set-Cookie': clearCookie});
      }

      // 实拍照片：登录后才给，不公开
      let match = path.match(/^\/media\/(.+)$/);
      if (match && method === 'GET') return serveMedia(env, decodeURIComponent(match[1]));

      // 工人页面（owner 也能看，方便你自己核对）
      if (path === '/w' && method === 'GET') return pickerHome(env, user, session);
      match = path.match(/^\/w\/(\d+)$/);
      if (match && method === 'GET') return pickerList(env, user, session, Number(match[1]));

      if (path === '/api/events' && method === 'POST') {
        let body; try { body = await request.json(); } catch { return json({error: '格式错误'}, 400); }
        if (!validCsrf(session, String(body?.csrf_token || ''))) return json({error: '请求已过期'}, 403);
        return json({ok: true, applied: await applyEvents(env, user.id, body?.events)});
      }

      // ↓↓↓ 以下只有你（owner）能用 ↓↓↓
      if (!owner) return method === 'GET' ? redirect('/w') : json({error: '无权限'}, 403);

      if (path === '/' && method === 'GET') return ownerHome(env, user, session);

      if (path === '/users' && method === 'GET') return usersPage(env, session);
      if (path === '/users' && method === 'POST') {
        const action = String(form.get('action') || ''), id = Number(form.get('id'));
        if (action === 'create') {
          const username = cleanText(form.get('username'), 40).toLowerCase();
          const password = String(form.get('password') || '');
          const display = cleanText(form.get('display_name'), 40);
          if (!/^[a-z0-9_.-]{3,40}$/.test(username) || password.length < 6 || !display)
            return usersPage(env, session, '资料不正确：账号3-40位小写，密码至少6位。');
          if (await first(env, 'SELECT id FROM app_user WHERE username=?', username))
            return usersPage(env, session, `账号 ${username} 已经存在。`);
          await run(env, 'INSERT INTO app_user(username,password_hash,display_name,role,is_active,created_at) VALUES(?,?,?,?,?,?)',
            username, await passwordHash(password), display, 'picker', 1, now());
        } else if (action === 'toggle') {
          await run(env, "UPDATE app_user SET is_active = 1 - is_active WHERE id=? AND role='picker'", id);
        } else if (action === 'password') {
          const password = String(form.get('password') || '');
          if (password.length < 6) return usersPage(env, session, '密码至少6位。');
          await run(env, "UPDATE app_user SET password_hash=? WHERE id=? AND role='picker'", await passwordHash(password), id);
          await run(env, 'DELETE FROM session WHERE user_id=?', id);
        }
        return redirect('/users');
      }

      if (path === '/api/lists' && method === 'POST') {
        const customer = cleanText(form.get('customer_label'), 40);
        if (!customer) return response('客户代号不能为空', 400);
        const stamp = now(), code = await nextListCode(env);
        const created = await run(env,
          `INSERT INTO picking_list(code,customer_label,note,status,created_by,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?)`, code, customer, cleanText(form.get('note'), 200), 'draft', user.id, stamp, stamp);
        return redirect(`/list/${created.meta.last_row_id}`);
      }

      match = path.match(/^\/list\/(\d+)$/);
      if (match && method === 'GET') return listPage(env, user, session, Number(match[1]));

      match = path.match(/^\/api\/lists\/(\d+)\/items$/);
      if (match && method === 'POST') {
        const listId = Number(match[1]);
        const list = await first(env, 'SELECT id,status FROM picking_list WHERE id=?', listId);
        if (!list) return response('拣货单不存在', 404);
        if (list.status !== 'draft') return response('这张单已经发出，先撤回再改。', 400);
        let photoKey = '';
        try { photoKey = await storePhoto(env, listId, form.get('photo')); }
        catch (error) { return response(`<main class="wrap"><p class="error">${esc(error.message)}</p><a class="btn" href="/list/${listId}">返回</a></main>`, 400); }
        const order = (await first(env, 'SELECT COALESCE(MAX(sort_order),-1) m FROM picking_item WHERE list_id=?', listId))?.m + 1;
        const style = cleanStyle(form.get('style'));
        const [floor, spot] = await resolvePlace(env, style,
          cleanText(form.get('floor'), 40), cleanText(form.get('spot'), 40));
        await run(env,
          `INSERT INTO picking_item(list_id,style,color,qty,floor,spot,note,photo_key,sort_order,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          listId, style, cleanText(form.get('color'), 40), cleanQty(form.get('qty')),
          floor, spot, cleanText(form.get('note'), 120), photoKey, order, now());
        await run(env, 'UPDATE picking_list SET updated_at=? WHERE id=?', now(), listId);
        return redirect(`/list/${listId}`);
      }

      match = path.match(/^\/api\/items\/(\d+)\/qty$/);
      if (match && method === 'POST') {
        const item = await first(env, 'SELECT id,list_id,qty,taken_qty FROM picking_item WHERE id=?', Number(match[1]));
        if (!item) return json({error: '条目不存在'}, 404);
        const qty = cleanQty(form.get('qty'));
        // 数量调小到比「已拿」还少时，把已拿一起收回来，否则会出现 3/2 这种数字。
        // 这一步也记一条流水，免得工人的拣货记录凭空对不上。
        const taken = Math.min(item.taken_qty, qty);
        await run(env, 'UPDATE picking_item SET qty=?, taken_qty=? WHERE id=?', qty, taken, item.id);
        if (taken !== item.taken_qty) {
          await run(env,
            `INSERT INTO picking_event(item_id,list_id,action,qty,user_id,client_uuid,created_at)
             VALUES(?,?,?,?,?,?,?)`,
            item.id, item.list_id, taken > 0 ? 'taken' : 'untaken', taken, user.id, `qty-${randomId()}`, now());
        }
        await run(env, 'UPDATE picking_list SET updated_at=? WHERE id=?', now(), item.list_id);
        return json({ok: true, qty, taken_qty: taken});
      }

      match = path.match(/^\/api\/items\/(\d+)\/delete$/);
      if (match && method === 'POST') {
        const item = await first(env, 'SELECT id,list_id,photo_key FROM picking_item WHERE id=?', Number(match[1]));
        if (!item) return response('条目不存在', 404);
        if (item.photo_key) await env.PHOTOS.delete(item.photo_key).catch(() => {});
        await run(env, 'DELETE FROM picking_item WHERE id=?', item.id);
        return redirect(`/list/${item.list_id}`);
      }

      match = path.match(/^\/api\/lists\/(\d+)\/status$/);
      if (match && method === 'POST') {
        const listId = Number(match[1]), status = String(form.get('status') || '');
        if (!['draft', 'sent', 'done', 'cancelled'].includes(status)) return response('状态不正确', 400);
        await run(env, 'UPDATE picking_list SET status=?, updated_at=? WHERE id=?', status, now(), listId);
        return redirect(status === 'cancelled' ? '/' : `/list/${listId}`);
      }

      return response('<main class="wrap"><p class="empty">页面不存在。</p><a class="btn" href="/">回首页</a></main>', 404);
    } catch (error) {
      console.error(error);
      return path.startsWith('/api/')
        ? json({error: '服务器处理失败'}, 500)
        : response(`<main class="wrap"><p class="error">服务器处理失败：${esc(error.message)}</p><a class="btn" href="/">回首页</a></main>`, 500);
    }
  }
};
