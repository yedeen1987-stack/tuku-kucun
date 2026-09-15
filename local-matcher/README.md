# 本地识图服务

图库的「拍照找货」从 **Worker 服务端**调这里，不是从浏览器调。这样：

- 不存在 HTTPS 页面调 HTTP 本地服务的混合内容问题
- 识图服务的 token 永远不会进到浏览器

代价是照片多走一跳（浏览器 → Worker → 识图服务），换来的是安全和「真的能用」。

## 它只做一件事

告诉你这张照片像哪几个款号，以及有多像。

**它不知道货位，也永远不要让它知道。** 楼层/左右由图库的 `style_location` 现查——
那是唯一真相源。

## 跑起来

```
MATCHER_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") \
  python3 matcher.py
```

监听 `127.0.0.1:8500`。然后用 cloudflared 暴露成 HTTPS，
配置见 `../docs/本地识图怎么接.md`。

Tunnel 是公网可达的，**没有 token 服务会拒绝所有请求**（返回 503），这是故意的。

## 接口

```
POST /search    {"fabric":"crepinho","image":"<base64>"}
              → {"candidates":[{"code":"YXS10237","score":0.94}, ...]}

POST /index     {"items":[{"code":"YXS10237","fabric":"crepinho","image":"<base64>"}]}
              → {"ok":true,"indexed":1}

GET  /health  → {"ok":true,"indexed":123}
```

全部要 `Authorization: Bearer <MATCHER_TOKEN>`。

`fabric` 是缩小范围用的。图库里面料是从款号前缀自动推导的
（`code_rule` 表：YXS → crepinho），所以按面料过滤 = 按前缀过滤。空表示全库搜。

## 现在的匹配算法是占位的

`_features()` 用的是 16×16 灰度指纹，够跑通流程，**但认不准真实布料**。

换成正经的：

1. `pip install torch torchvision faiss-cpu pillow`
2. 载入 **DINOv2**（`facebook/dinov2-base`）。布料纹理上它比 CLIP 明显好。
3. `_features()` 改成返回 DINOv2 的 embedding
4. `_search()` 改成用 faiss 做向量检索
5. 再叠一层颜色直方图做二次排序，能压掉一部分素色误判

整套在 CPU 上跑得动，不需要显卡。

## 素色布这条路是死的

一块黑色 Crepinho 和一块黑色 Duna，照片上完全一样，识图必然失败。

所以图库那个页面**永远保留**「搜款号 / 按面料浏览 → 人工选」。
那不是识图失败时才出现的备用界面，是和识图并排的正常路径之一。
