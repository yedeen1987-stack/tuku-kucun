# 给 Codex 的任务单

把这份文件整个贴给 Codex，或者让它读 `/srv/projects/tuku-kucun/integration/给Codex的任务单.md`。

**授权范围（一次说清，省得每步都问）**

- 允许修改 `/srv/projects/textil134` 和 `/srv/projects/xiaoshouruanjian`
- 允许新建 `/srv/projects/tuku-kucun` 和 `/srv/projects/textil134-matcher`
- 允许对这两个项目执行 `wrangler deploy`（部署是这次任务的目标，不是副作用）
- 允许创建 D1 数据库、R2 桶、设置 secret
- **不允许**：改动其他项目、动 Portainer、全局 prune、碰 `/mnt/ugreen` 里无关文件
- **不要在报告里输出任何 token、密码、secret 的值**，只说「已设置」

按 A→E 顺序做。**每个任务做完停下来报告，等确认再做下一个。**

**token 对照表**（同一个值要设在两个地方，配错了会静默失效，务必对照）

| token | 在哪生成 | 要设到哪些地方 |
|---|---|---|
| `SESSION_SECRET` | 任务 B | 拿货小程序 |
| `IMPORT_TOKEN` | 任务 B | 拿货小程序 + 图库的 `PICKING_TOKEN`（**同值**）|
| `LOCATION_TOKEN` | 任务 C | 图库 + 拿货小程序的 `GALLERY_TOKEN`（**同值**）|
| `MATCHER_TOKEN` | 任务 E | 识图服务 + 图库的 `MATCHER_TOKEN`（**同值**）|
| `STOCK_SYNC_TOKEN` | 已经有了 | **不要动** |

---

## 任务 A · 取代码

两个仓库。图库的改动**已经推成分支了，不需要打补丁**。

```bash
# 1) 图库：我的改动在这个分支上
cd /srv/projects/textil134
git fetch origin
git branch -a | grep feature/locations-and-find

# 2) 拿货小程序：新项目的代码
git clone --depth 1 --branch claude/zen-cerf-zn4iz9 \
  https://github.com/yedeen1987-stack/tuku-kucun.git /srv/projects/tuku-kucun
```

**验收**：`git branch -a` 能看到 `remotes/origin/feature/locations-and-find`，
并且 `/srv/projects/tuku-kucun` 里有 `src/worker.js` 和 `schema.sql`。

---

## 任务 B · 部署「拿货小程序」（新项目）

这是工人手机用的拣货系统。代码就在刚 clone 的仓库里。

任务 A 已经 clone 好了，直接用：

```bash
cd /srv/projects/tuku-kucun
npm install
```

`integration/` 和 `local-matcher/` 两个目录留着，后面任务 D、E 要用。

### B1 建数据库和图片桶

```bash
npx wrangler d1 create textil134-picking
npx wrangler r2 bucket create textil134-picking-photos
```

第一条会输出一个 `database_id`，**把它填进 `wrangler.jsonc`**，替换掉那串全 0 的占位符。

### B2 建表

```bash
npx wrangler d1 execute textil134-picking --remote --file=schema.sql
```

### B3 设密钥

生成两个随机串（**不要打印到报告里**）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- `SESSION_SECRET` — 随机生成
- `IMPORT_TOKEN` — 随机生成，**记下来，任务 D 要用同一个值**

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put IMPORT_TOKEN
```

### B4 部署

```bash
npx wrangler deploy
```

记下输出的网址，记作 `拿货网址`。

### B5 验收

1. 打开 `拿货网址`，应该自动跳到 `/setup`
2. **这一步交给人做**：建管理员账号（Codex 不要代设密码）
3. 建完之后再访问 `/setup`，应该跳走（不再可用）

**报告**：拿货网址、D1 database_id、部署是否成功、`/setup` 是否按预期关闭。
**不要报告任何 token 的值。**

---

## 任务 C · 图库：货位管理 + 拍照找货 + 分批同步

**前置**：任务 B 完成（需要拿货网址和 IMPORT_TOKEN）。

### C1 ⚠️ 先确认导入的代码是不是最新的

这一步**不能跳**。图库代码以前从来没推到 GitHub，仓库里只有 README 和 AGENTS.md。
我推的分支里第一个提交 `b53d3a2` 是「导入服务器上的现有图库代码」，
内容来自用户上传的 zip 压缩包。

**如果服务器上的代码比那个 zip 新，直接合并会丢掉服务器上的改动。**

```bash
cd /srv/projects/textil134
git stash list && git status          # 服务器上有没有未提交的改动？
git diff b53d3a2 -- src/ public/      # 服务器当前代码 vs 导入的那份
```

- **没有差异** → 继续 C2
- **有差异** → **停下来报告差异内容**，不要自己决定怎么合

### C2 切到分支

```bash
git checkout feature/locations-and-find
node --check src/worker.js            # 应该无输出
```

### C3 设 token

| 变量 | 值 |
|---|---|
| `LOCATION_TOKEN` | 随机生成，至少 24 位，**记下来 C5 要用** |
| `PICKING_URL` | 任务 B 的「拿货网址」 |
| `PICKING_TOKEN` | 任务 B 生成的 `IMPORT_TOKEN`，**同一个值** |

```bash
npx wrangler secret put LOCATION_TOKEN
npx wrangler secret put PICKING_URL
npx wrangler secret put PICKING_TOKEN
```

`MATCHER_URL` 和 `MATCHER_TOKEN` **先不设**（任务 E 再设）。
不设时拍照找货页会显示「还没有配置本地识图服务」，然后自动走人工选——
**这条路径是设计好的，不是降级**，正好趁现在验证兜底真的能用。

### C4 部署

建表不用手工跑，Worker 第一次收到请求会自动建。

```bash
npx wrangler deploy
```

### C5 让拿货小程序能读货位

```bash
cd /srv/projects/tuku-kucun
npx wrangler secret put GALLERY_URL      # 图库网址
npx wrangler secret put GALLERY_TOKEN    # C3 的 LOCATION_TOKEN，同一个值
npx wrangler deploy
```

### C6 验收（逐条做，逐条报）

1. 后台顶栏出现「📷 拍照找货」「🛒 拣货篮」「货位管理」「库存同步」
2. `/admin/locations` 打得开，显示「X / Y 个款号已设货位」
3. **关键**：客户图库 `/catalog` 上**搜不到任何「楼层/左/右」字样**
4. 不带 token `curl <图库网址>/api/style-locations` → 401
5. `/admin/find` 三块都在；传一张图会提示「还没有配置本地识图服务」，
   **但照片显示出来了，下面的人工选照常可用**
6. 人工选一个款号加入拣货篮 → `/admin/cart` → 点「发送拣货」
7. 打开「拿货网址」的 `/w`，这张单出现了，**而且能看到刚传的那张照片**
8. 在货位管理给某款号设个货位 → 到拿货小程序建单、只填这个款号、楼层留空 →
   保存后应该自动带出货位

第 7 条是整条链路打通的标志，重点确认。

**报告**：C1 的 diff 结果（最重要）、部署结果、上面 8 条各自结果。

---

## 任务 D · 销售软件分批同步

**前置**：任务 C 完成（图库已有 `stock_sync_state` 表）。

```bash
cd /srv/projects/xiaoshouruanjian   # 如果销售软件在 Windows 机器上，这一步在那台机器做
git status
cp /srv/projects/tuku-kucun/integration/xiaoshouruanjian/stock_push.py ./stock_push.py
```

（也可以用 `0001-分批同步.patch`，但直接覆盖更简单，这个文件是整体重写的。）

### D1 先查数据量，这是要回报的重点

```bash
python3 -c "
import sqlite3
db = sqlite3.connect('data/stock.sqlite3')
print('款号数        ', db.execute('SELECT COUNT(DISTINCT style) FROM stock_code').fetchone()[0])
print('款号×色号组合 ', db.execute('SELECT COUNT(*) FROM stock_code').fetchone()[0])
print('已设货位的款号', db.execute(\"SELECT COUNT(*) FROM stock_style WHERE location != ''\").fetchone()[0])
print()
for style, loc in db.execute(\"SELECT style,location FROM stock_style WHERE location != '' ORDER BY style LIMIT 20\"):
    print(' ', style, '->', repr(loc))
"
```

### D2 手工推一次

```bash
python3 stock_push.py
```

应该输出类似 `{"ok": true, "count": 1234, "batches": 3, ...}`。

### D3 验收

1. 上面的输出里 `batches` 大于等于 1，`ok` 为 true
2. `data/stock-sync-status.json` 存在，里面 `"ok": true`、`"failures": 0`
3. 图库后台 `/admin/stock-sync` 显示「同步正常」，条数和 D2 的 `count` 对得上

**报告**：D1 的三个数字 + 那 20 行 location 样本（这个很重要，决定要不要做货位迁移）、
D2 的输出（可以带上，里面没有密钥）、D3 三条验收结果。

---

## 任务 E · 本地识图服务 + Cloudflare Tunnel

**前置**：任务 C 完成。

代码在 `/srv/projects/tuku-kucun/local-matcher/`。

### E1 跑起来

```bash
mkdir -p /srv/projects/textil134-matcher
cp /srv/projects/tuku-kucun/local-matcher/* /srv/projects/textil134-matcher/
cd /srv/projects/textil134-matcher
pip3 install pillow          # 只需要这一个
```

生成 `MATCHER_TOKEN`（随机，至少 24 位，**记下来，E3 要用同一个值**），然后：

```bash
MATCHER_TOKEN=<刚生成的> MATCHER_PORT=8500 python3 matcher.py
```

做成 systemd 服务开机自启（token 放进 `EnvironmentFile`，**不要写进 unit 文件里**）。

### E2 Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create textil134-match
cloudflared tunnel route dns textil134-match match.<你的域名>
```

`~/.cloudflared/config.yml`：

```yaml
tunnel: textil134-match
credentials-file: /root/.cloudflared/<隧道ID>.json
ingress:
  - hostname: match.<你的域名>
    service: http://127.0.0.1:8500
  - service: http_status:404
```

```bash
cloudflared service install
```

**安全检查（必须做）**：从外网 `curl https://match.<你的域名>/health` 不带 token，
**必须返回 401**。如果返回了数据，立刻停掉隧道并报告——
这个地址是公网可达的，无鉴权等于把整个图库特征索引开放给所有人。

### E3 接到图库

```bash
cd /srv/projects/textil134
npx wrangler secret put MATCHER_URL      # https://match.<你的域名>
npx wrangler secret put MATCHER_TOKEN    # E1 那个值
npx wrangler deploy
```

### E4 建索引

把图库里的图片喂给识图服务。**这一步需要单独写个脚本**：
遍历图库 R2 里的产品图，按款号和面料调 `POST /index`。
接口格式见 `local-matcher/README.md`。

**先别写这个脚本**，做到 E3 停下来报告，我们确认识图链路通了再说。

### E5 验收

打开图库 `/admin/find`，选一个面料，传一张图，应该出现 Top3 候选
（索引还是空的话候选也是空的，但**不应该再显示「还没有配置本地识图服务」**）。

**报告**：E2 那个 401 安全检查的结果（最重要）、E5 的结果。

---

## 报告格式

每个任务做完，按 `AGENTS.md` 第 11 节报：

1. 改了什么
2. 改了哪些文件
3. 做了哪些测试/检查
4. 测试是否通过
5. Git 状态
6. 有没有提交
7. 有没有推送
8. 有没有部署
9. 剩余风险或需要决策的地方

**任何 token / 密码 / secret 的值都不要出现在报告里。**

---

## 几条不要做的事

- 不要把货位字段加到 `product` 表上（补丁里是单独一张 `style_location` 表，
  因为 product 是一行一张图，同一个款号有 5 张图就会存 5 份货位）
- 不要把 `stock_push.py` 里的 `BATCH_SIZE` 调到 1000 以上（线上单批上限就是 1000）
- 不要动销售软件的 `stock_style.location`——货位真相源是图库的 `style_location`，
  迁移方案等任务 D 的数据出来再定
- 不要做库存扣减或销售集成，这次范围到此为止
