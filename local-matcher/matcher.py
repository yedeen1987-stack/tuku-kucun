"""本地识图服务 · 参考实现

图库的「拍照找货」会从 Worker 服务端调这里（不是从浏览器调，
所以不存在 HTTPS 页面调 HTTP 的混合内容问题，token 也不会进浏览器）。

它只做一件事：告诉你这张照片像哪几个款号，以及有多像。
【它不知道货位，也永远不要让它知道。】楼层/左右由图库的 style_location 现查。

接口
----
POST /search
    Authorization: Bearer <MATCHER_TOKEN>
    {"fabric": "crepinho", "contentType": "image/jpeg", "image": "<base64>"}
  →
    {"candidates": [{"code": "YXS10237", "score": 0.94}, ...]}

    fabric 是缩小范围用的：图库里面料是从款号前缀自动推导的
    （code_rule 表：YXS → crepinho），所以按面料过滤 = 按前缀过滤。
    fabric 为空表示全库搜。

POST /index
    Authorization: Bearer <MATCHER_TOKEN>
    {"items": [{"code": "YXS10237", "fabric": "crepinho", "image": "<base64>"}]}
  → {"ok": true, "indexed": 1}

    增量加图片。图库新上传的款号调这个，不用重建整个索引。

GET /health → {"ok": true, "indexed": 123}

怎么换成真正的识图
------------------
现在 `_features()` 用的是一个很粗糙的占位算法（缩略图灰度指纹），
够跑通流程，但认不准真实布料。要换成正经的：

    1. pip install torch torchvision faiss-cpu pillow
    2. 载入 DINOv2（facebook/dinov2-base）。布料纹理上它比 CLIP 明显好。
    3. _features() 改成返回 DINOv2 的 embedding
    4. _search() 改成用 faiss 做向量检索
    5. 再叠一层颜色直方图做二次排序，能压掉一部分素色误判

    整套在 CPU 上跑得动，不需要显卡。

【素色布这条路是死的】：一块黑色 Crepinho 和一块黑色 Duna，
照片上完全一样，识图必然失败。所以图库那个页面永远保留
「搜款号 / 按面料浏览 → 人工选」——这不是备用界面，是正常路径之一。

跑起来
------
    MATCHER_TOKEN=xxx python3 matcher.py          # 监听 127.0.0.1:8500

然后用 cloudflared 把它暴露成 HTTPS（见 docs/本地识图怎么接.md）。
"""
import base64
import hashlib
import io as _io
import json
import os
import sqlite3
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = os.environ.get("MATCHER_TOKEN", "")
PORT = int(os.environ.get("MATCHER_PORT", "8500"))
DB_PATH = Path(os.environ.get("MATCHER_DB", "matcher.sqlite3"))
MAX_BODY = 20 * 1024 * 1024

_lock = threading.Lock()


def _db():
    db = sqlite3.connect(str(DB_PATH))
    db.execute("""CREATE TABLE IF NOT EXISTS item (
        code TEXT PRIMARY KEY COLLATE NOCASE,
        fabric TEXT NOT NULL DEFAULT '',
        features TEXT NOT NULL)""")
    return db


def _features(image_bytes):
    """占位特征：把图缩成 16x16 灰度指纹。

    换成 DINOv2 的时候只要改这个函数的返回值（一串 float），
    _score() 里的比较方式跟着换成余弦相似度即可。
    """
    try:
        from PIL import Image
        img = Image.open(_io.BytesIO(image_bytes)).convert("L").resize((16, 16))
        return [px / 255.0 for px in img.getdata()]
    except ImportError:
        # 没装 Pillow 也要能跑（测试环境），退化成字节指纹
        digest = hashlib.sha256(image_bytes).digest()
        return [b / 255.0 for b in digest[:32]]


def _score(a, b):
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return 0.0 if not na or not nb else max(0.0, min(1.0, dot / (na * nb)))


def do_index(payload):
    items = payload.get("items") or []
    with _lock:
        db = _db()
        try:
            with db:
                for item in items:
                    code = str(item.get("code") or "").strip().upper()
                    if not code:
                        continue
                    image = base64.b64decode(item.get("image") or "")
                    if not image:
                        continue
                    db.execute("INSERT OR REPLACE INTO item(code,fabric,features) VALUES(?,?,?)",
                               (code, str(item.get("fabric") or "").strip(),
                                json.dumps(_features(image))))
            return {"ok": True, "indexed": len(items)}
        finally:
            db.close()


def do_search(payload):
    image = base64.b64decode(payload.get("image") or "")
    if not image:
        return {"candidates": [], "error": "没有收到图片"}
    fabric = str(payload.get("fabric") or "").strip()
    target = _features(image)
    with _lock:
        db = _db()
        try:
            # 按面料缩小范围：不给面料就全库搜
            if fabric:
                rows = db.execute("SELECT code,features FROM item WHERE fabric=? COLLATE NOCASE", (fabric,)).fetchall()
            else:
                rows = db.execute("SELECT code,features FROM item").fetchall()
        finally:
            db.close()
    scored = [(code, _score(target, json.loads(features))) for code, features in rows]
    scored.sort(key=lambda row: row[1], reverse=True)
    return {"candidates": [{"code": code, "score": round(score, 4)} for code, score in scored[:3]]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        # Tunnel 是公网可达的，没有 token 绝不放行
        if len(TOKEN) < 16:
            self._send(503, {"error": "MATCHER_TOKEN 没设，服务拒绝提供"})
            return False
        if self.headers.get("Authorization", "") != "Bearer " + TOKEN:
            self._send(401, {"error": "无权限"})
            return False
        return True

    def do_GET(self):
        if self.path == "/health":
            if not self._authorized():
                return
            db = _db()
            try:
                count = db.execute("SELECT COUNT(*) FROM item").fetchone()[0]
            finally:
                db.close()
            return self._send(200, {"ok": True, "indexed": count})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._send(413, {"error": "请求太大"})
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._send(400, {"error": "格式错误"})
        try:
            if self.path == "/search":
                return self._send(200, do_search(payload))
            if self.path == "/index":
                return self._send(200, do_index(payload))
        except Exception as exc:                      # noqa: BLE001
            return self._send(500, {"error": str(exc)})
        self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        sys.stderr.write("[matcher] " + fmt % args + "\n")


if __name__ == "__main__":
    if len(TOKEN) < 16:
        print("警告：MATCHER_TOKEN 没设或太短，服务会拒绝所有请求。", file=sys.stderr)
    print("本地识图服务监听 127.0.0.1:%d，索引库 %s" % (PORT, DB_PATH), file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
