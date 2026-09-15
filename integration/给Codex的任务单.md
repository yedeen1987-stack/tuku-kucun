# 给 Codex 的任务单

把这份文件整个贴给 Codex，或者让它读 `/srv/projects/tuku-kucun-patches/integration/给Codex的任务单.md`。

**授权范围（一次说清，省得每步都问）**

- 允许修改 `/srv/projects/textil134` 和 `/srv/projects/xiaoshouruanjian`
- 允许新建 `/srv/projects/tuku-kucun`
- 允许对这两个项目执行 `wrangler deploy`（部署是这次任务的目标，不是副作用）
- 允许创建 D1 数据库、R2 桶、设置 secret
- **不允许**：改动其他项目、动 Portainer、全局 prune、碰 `/mnt/ugreen` 里无关文件
- **不要在报告里输出任何 token、密码、secret 的值**，只说「已设置」

按 A→F 顺序做。**每个任务做完停下来报告，等确认再做下一个。**

**token 对照表**（同一个值要设在两个地方，配错了会静默失效，务必对照）

| token | 在哪生成 | 要设到哪些地方 |
|---|---|---|
| `SESSION_SECRET` | 任务 B | 拿货小程序 |
| `IMPORT_TOKEN` | 任务 B | 拿货小程序 + 图库的 `PICKING_TOKEN`（**同值**）|
| `LOCATION_TOKEN` | 任务 C | 图库 + 拿货小程序的 `GALLERY_TOKEN`（**同值**）|
| `MATCHER_TOKEN` | 任务 F | 识图服务 + 图库的 `MATCHER_TOKEN`（**同值**）|
| `STOCK_SYNC_TOKEN` | 已经有了 | **不要动** |

---

## 任务 A · 取补丁

补丁在一个公开仓库里，直接 clone 到项目目录外的地方：

```bash
git clone --depth 1 --branch claude/zen-cerf-zn4iz9 \
  https://github.com/yedeen1987-stack/tuku-kucun.git /srv/projects/tuku-kucun-patches
cd /srv/projects/tuku-kucun-patches
ls integration/textil134/
```

（必须带 `--branch`。浅克隆默认只取默认分支，不带这个参数会 clone 成功但目录里没有补丁。）

应该看到 `0001-货位管理.patch` 和 `0002-拍照找货与分批同步.patch`。

**验收**：两个 patch 文件存在。

---

## 任务 B · 部署「拿货小程序」（新项目）

这是工人手机用的拣货系统。代码就在刚 clone 的仓库里。

```bash
cp -r /srv/projects/tuku-kucun-patches /srv/projects/tuku-kucun
cd /srv/projects/tuku-kucun
rm -rf integration local-matcher .git
npm install
```

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

## 任务 C · 图库补丁 1（货位管理）

```bash
cd /srv/projects/textil134
git status                      # 确认干净，有未提交改动先停下来问
git checkout -b feature/locations
git apply --check /srv/projects/tuku-kucun-patches/integration/textil134/0001-货位管理.patch
git apply /srv/projects/tuku-kucun-patches/integration/textil134/0001-货位管理.patch
```

`--check` 通过才继续。不通过就停下来报告，**不要用 `--3way` 或手工改**。

### C1 设 token

- `LOCATION_TOKEN` — 随机生成（至少 24 位），**记下来，任务 E 要用同一个值**

```bash
npx wrangler secret put LOCATION_TOKEN
```

### C2 部署

建表不用手工跑，Worker 第一次收到请求会自动建。

```bash
npx wrangler deploy
```

### C3 验收

1. 后台顶栏应该多出「货位管理」
2. 打开 `/admin/locations`，能看到款号列表和「X / Y 个款号已设货位」
3. **关键**：打开客户图库 `/catalog`，确认页面上**搜不到任何「楼层/左/右」字样**
4. `curl -s <图库网址>/api/style-locations` 不带 token，应该返回 401

### C4 让拿货小程序能读货位

回到拿货小程序，设两个变量：

```bash
cd /srv/projects/tuku-kucun
npx wrangler secret put GALLERY_URL      # 图库网址，例如 https://textil134-stock-marker.xxx.workers.dev
npx wrangler secret put GALLERY_TOKEN    # C1 生成的 LOCATION_TOKEN，同一个值
npx wrangler deploy
```

配好之后，在拿货小程序里加拣货条目时**楼层留空就行**，会按款号自动从图库带出来。

验证：在图库「货位管理」给某个款号设个货位 → 到拿货小程序建一张单 →
加一项只填这个款号、楼层留空 → 保存后应该自动显示出货位。

配不上也不影响用（会留空让你手工填，不报错），但那样就白费这一步了。

**报告**：补丁是否干净应用、部署结果、C3 的 4 条验收、C4 的自动带出货位是否生效。

---

## 任务 D · 图库补丁 2（拍照找货 + 分批同步）

**前置**：任务 B 和 C 都完成。

```bash
cd /srv/projects/textil134
git add -A && git commit -m "货位管理"          # 先把补丁1的改动提交，便于回滚
git apply --check /srv/projects/tuku-kucun-patches/integration/textil134/0002-拍照找货与分批同步.patch
git apply /srv/projects/tuku-kucun-patches/integration/textil134/0002-拍照找货与分批同步.patch
```

### D1 设 4 个变量

| 变量 | 值 |
|---|---|
| `PICKING_URL` | 任务 B 的「拿货网址」 |
| `PICKING_TOKEN` | 任务 B 生成的 `IMPORT_TOKEN`，**同一个值** |
| `MATCHER_URL` | 先留空不设（任务 F 做完再设） |
| `MATCHER_TOKEN` | 先留空不设 |

```bash
npx wrangler secret put PICKING_URL
npx wrangler secret put PICKING_TOKEN
```

**`MATCHER_URL` 现在不设是故意的**：识图服务还没有，页面会显示「还没有配置本地识图服务」，
然后自动用「搜款号 / 按面料浏览」人工选——这条路径是设计好的，不是降级。

### D2 部署并验收

```bash
npx wrangler deploy
```

1. 顶栏出现「📷 拍照找货」和「🛒 拣货篮」
2. 打开 `/admin/find`，三块都在：选面料 / 拍照上传 / 认不出来就自己选
3. 随便传一张图，应该提示「识图没能用上：还没有配置本地识图服务」，
   **但照片显示出来了，下面的人工选照常能用**
4. 人工选一个款号加入拣货篮 → 打开 `/admin/cart` → 点「发送拣货」
5. 打开「拿货网址」的 `/w`，确认这张单出现了，而且**能看到你刚传的那张照片**
6. 打开 `/admin/stock-sync`，能看到库存同步状态页

**报告**：上面 6 条各自结果。第 5 条是整条链路打通的标志，重点确认。

---

## 任务 E · 销售软件分批同步

**前置**：任务 C 完成（图库已有 `stock_sync_state` 表）。

```bash
cd /srv/projects/xiaoshouruanjian   # 如果销售软件在 Windows 机器上，这一步在那台机器做
git status
cp /srv/projects/tuku-kucun-patches/integration/xiaoshouruanjian/stock_push.py ./stock_push.py
```

（也可以用 `0001-分批同步.patch`，但直接覆盖更简单，这个文件是整体重写的。）

### E1 先查数据量，这是要回报的重点

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

### E2 手工推一次

```bash
python3 stock_push.py
```

应该输出类似 `{"ok": true, "count": 1234, "batches": 3, ...}`。

### E3 验收

1. 上面的输出里 `batches` 大于等于 1，`ok` 为 true
2. `data/stock-sync-status.json` 存在，里面 `"ok": true`、`"failures": 0`
3. 图库后台 `/admin/stock-sync` 显示「同步正常」，条数和 E2 的 `count` 对得上

**报告**：E1 的三个数字 + 那 20 行 location 样本（这个很重要，决定要不要做货位迁移）、
E2 的输出（可以带上，里面没有密钥）、E3 三条验收结果。

---

## 任务 F · 本地识图服务 + Cloudflare Tunnel

**前置**：任务 D 完成。

代码在 `/srv/projects/tuku-kucun-patches/local-matcher/`。

### F1 跑起来

```bash
mkdir -p /srv/projects/textil134-matcher
cp /srv/projects/tuku-kucun-patches/local-matcher/* /srv/projects/textil134-matcher/
cd /srv/projects/textil134-matcher
pip3 install pillow          # 只需要这一个
```

生成 `MATCHER_TOKEN`（随机，至少 24 位，**记下来，F3 要用同一个值**），然后：

```bash
MATCHER_TOKEN=<刚生成的> MATCHER_PORT=8500 python3 matcher.py
```

做成 systemd 服务开机自启（token 放进 `EnvironmentFile`，**不要写进 unit 文件里**）。

### F2 Tunnel

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

### F3 接到图库

```bash
cd /srv/projects/textil134
npx wrangler secret put MATCHER_URL      # https://match.<你的域名>
npx wrangler secret put MATCHER_TOKEN    # F1 那个值
npx wrangler deploy
```

### F4 建索引

把图库里的图片喂给识图服务。**这一步需要单独写个脚本**：
遍历图库 R2 里的产品图，按款号和面料调 `POST /index`。
接口格式见 `local-matcher/README.md`。

**先别写这个脚本**，做到 F3 停下来报告，我们确认识图链路通了再说。

### F5 验收

打开图库 `/admin/find`，选一个面料，传一张图，应该出现 Top3 候选
（索引还是空的话候选也是空的，但**不应该再显示「还没有配置本地识图服务」**）。

**报告**：F2 那个 401 安全检查的结果（最重要）、F5 的结果。

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
  迁移方案等任务 E 的数据出来再定
- 不要做库存扣减或销售集成，这次范围到此为止
