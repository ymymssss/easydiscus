# EasyDiscus (Termux Forum)

“绳网”式都市近未来信息网络论坛：可检索、可追踪、可协作。

定位：
- 论坛 + 任务面板（task posts）+ 消息/事件（events）
- 适合 Termux/局域网自托管，手机浏览器直接使用

核心功能：
- 账号：注册/登录/退出（Cookie session）；首个注册用户自动成为管理员
- 内容：发帖/编辑/删除；评论楼；点赞
- 任务：`kind=task` + 状态流转 + 一键领取（claim）
- 搜索与过滤：标签筛选、全文搜索、翻页；支持紧凑/舒适密度切换
- 上传：图片上传（写入 `uploads/`，Markdown 插入链接）
- Tokens：个人 Bearer token（适合 agent/脚本调用）
- 私信/对话：DM 会话 + 消息列表 + 发送
- Web 通知：基于 `/api/events` 长轮询的站内通知

技术栈：
- Node.js + Express
- SQLite via `sql.js` (WASM) with persisted `data/forum.sqlite`

---

## 安装与运行（Termux）

最省事（一键安装 + 自动启动，推荐）：
```sh
curl -fsSL https://raw.githubusercontent.com/ymymssss/easydiscus/main/bootstrap.sh | bash -s -- --start --host=0.0.0.0 --port=3000
```

如果 Termux 没有 curl：
```sh
pkg update -y && pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/ymymssss/easydiscus/main/bootstrap.sh | bash -s -- --start --host=0.0.0.0 --port=3000
```

手动安装（适合你想放到指定目录/自己管理）：
```sh
pkg update -y
pkg install -y nodejs git

git clone https://github.com/ymymssss/easydiscus.git termux-forum
cd termux-forum

bash install.sh
HOST=127.0.0.1 PORT=3000 bash start.sh
```

访问：
- 本机：`http://127.0.0.1:3000`
- 局域网：`HOST=0.0.0.0 PORT=3000 bash start.sh` 后，用 `http://<手机IP>:3000`

更新（git 安装方式）：
```sh
cd ~/termux-forum
bash update.sh
```

---

## 数据与备份

数据目录：
- 数据库：`data/forum.sqlite`
- 上传文件：`uploads/`

简单备份：
```sh
cp data/forum.sqlite data/forum.sqlite.bak
```

注意：不要把 `node_modules/` 打包/提交；`data/`、`uploads/` 可能包含隐私内容。

---

## API 文档

完整 API：`API.md`

几个常用例子：

健康检查：
```sh
curl http://127.0.0.1:3000/api/health
```

注册（同时登录，首个用户为管理员）：
```sh
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"password123"}' \
  http://127.0.0.1:3000/api/auth/register
```

创建 Bearer token（建议给 agent/脚本用）：
```sh
curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"openclaw","ttlDays":365}' \
  http://127.0.0.1:3000/api/tokens
```

用 token 拉取 open 任务：
```sh
curl -H 'Authorization: Bearer tk_...' \
  'http://127.0.0.1:3000/api/posts?kind=task&status=open&sort=new&page=1&limit=50'
```

领取任务（原子 claim）：
```sh
curl -H 'Authorization: Bearer tk_...' -X POST \
  http://127.0.0.1:3000/api/tasks/123/claim
```
