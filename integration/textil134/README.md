# 给「库存图记」的货位补丁

这个目录不是拿货小程序的一部分，是要**打到你图库项目里**的补丁
（服务器上的 `/srv/projects/textil134`）。

## 这个补丁做了什么

给图库加「货位管理」：款号 → 楼层 · 左右。

1. 两张新表 `style_location` 和 `style_location_change`
2. 后台新页面 `/admin/locations`，顶栏多一个「货位管理」入口
3. 新接口 `GET /api/style-locations`，给拿货小程序读货位用
4. 改了 `public/app.css`，加了这个页面的样式

**没有动**任何现有功能：客户目录、产品管理、标记、面料规则、库存同步全部原样。

## 为什么货位要单独建表，不加在 product 上

`product` 表是**一行一张图**，`code`（款号）只有索引、没有唯一约束。
`YXS10237` 如果有 5 张图，就是 5 行。

如果把 `floor`/`side` 加在 `product` 上，一个款号就存了 5 份货位。
搬一次货要改 5 行，改漏一行，识图匹到那张图就显示旧位置，而且很难发现。

所以货位单独一张表，**款号做主键，一个款号一条**，搬货改一次就完成。

顺带一个好处：客户目录 `catalogPage` 只 SELECT product 的固定几列，
这张新表根本不参与那条查询，所以货位在结构上就不可能泄露给客户。
（这一条我写了测试专门验证，见下面。）

## 怎么应用

在图库项目目录里：

```
git checkout -b feature/locations
git apply integration/textil134/0001-货位管理.patch
```

或者先看看会改什么：

```
git apply --check 0001-货位管理.patch   # 只检查，不改文件
git apply --stat  0001-货位管理.patch   # 看改动统计
```

补丁是对着你现在这份代码生成的，可以干净应用。

### 建表

Worker 的 `ensureSchema` 会在第一次请求时自动建表，所以**不用手工跑迁移**。
想提前建也可以：

```
npx wrangler d1 execute textil134-stock-marker --remote --file=migrations/0005_style_location.sql
```

### 设 token（给拿货小程序读货位用）

```
npx wrangler secret put LOCATION_TOKEN
```

要一串至少 24 位的随机字符串：

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

不设这个 token，`/api/style-locations` 会返回 503，等于这个接口关着。
其他功能不受影响。

### 部署

```
npx wrangler deploy
```

## 怎么用

后台顶栏 →「货位管理」。

第一次建资料时最费时间的是「把几千个款号填上楼层」，所以这个页面：

- 默认**只列还没设货位的款号**（点「显示全部款号」切换）
- 可以按款号或面料搜索
- **勾一批款号 → 填楼层和位置 → 点一次全部设定**

搬货以后改一次，所有照片、所有色号都跟着变。每次改动都会记一条流水
（谁、什么时候、从哪搬到哪、什么原因），页面下方能看到。

值没变的时候重复保存不会记流水，所以记录不会被刷爆。

## 已经验证过的

我在本地把补丁打上、用你的 `seed-local.sql` 起了一份图库，跑了 11 项测试：

1. 管理员能登录
2. 顶栏出现「货位管理」入口
3. 货位管理页能打开，统计正确（7 个款号 / 0 个已设）
4. 勾 3 个款号一次批量设成「1楼·左」
5. 搬货记流水：`1楼·左 → 2楼·右 · 总管理员 · 搬到二楼`
6. 值没变时重复保存**不**记流水
7. **客户目录和客户产品详情页搜不到任何楼层/左右字样**
8. 未登录打不开货位管理 → 302
9. 货位 API 无 token / 错 token → 401
10. 正确 token 只返回款号+货位，不含价格和图片信息
11. 客户目录的面料筛选、面料规则页都还正常

## 接口格式

```
GET /api/style-locations
Authorization: Bearer <LOCATION_TOKEN>

{
  "ok": true,
  "count": 3,
  "items": [
    {"code":"YXS10237","floor":"2楼","side":"右","updated_at":"..."}
  ]
}
```

只返回**已经设了货位**的款号。不含价格、图片、客户、库存数量。
