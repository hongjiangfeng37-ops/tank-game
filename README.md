# 🛡️ 坦克动荡 · 多人联机版

仿 4399《坦克动荡》的俯视角坦克对战游戏，支持**远程多人联机**和**手机触屏游玩**。
纯 Node.js 标准库实现（零 npm 依赖），一个文件夹即可部署。

- **玩法**：竞技场坦克大乱斗，最后一辆坦克获胜。坦克带滑行惯性，炮弹可反弹 3 次，地图有障碍物，捡道具强化（回血 / 护盾 / 速射 / 三连发）。
- **联机**：① 局域网房间列表（免输房间号，点一下加入）② 房间号直连 ③ **游戏内一键公网通道**（自动下载 cloudflared，生成公网链接，好友跨网络直接打开）。

## 快速开始

```bash
node server.js            # 默认端口 8123，被占用时自动顺延
# 或指定端口
node server.js 9000
# 或设置环境变量 PORT
set PORT=9000 && node server.js
```

Windows 也可直接双击 **start.cmd**。

启动后打开浏览器访问：

- 本机：http://127.0.0.1:8123/
- 局域网：http://<你的局域网IP>:8123/（服务器启动时会打印）

## 如何获得固定的网址（别人随时能玩）

想给朋友一个**永远不变的网址**（打开就能玩、不用等你开电脑），把游戏部署到免费托管平台即可。已内置部署配置，全程约 10 分钟：

### 方案 A：Glitch（最简单，无需 Git，推荐新手）
1. 打开 [glitch.com](https://glitch.com)，用 Google/GitHub 账号注册登录。
2. 点 **New Project → glitch-hello-node** 创建示例项目。
3. 进入项目编辑器，在左侧文件树里**全选删除所有文件**（index.js、public 等示例文件）。
4. 把本 `tank-game` 文件夹里的 `server.js`、`public`、`package.json`、`Procfile` 四个东西**直接拖拽**进文件树（可以只拖这 4 项，`bin` 目录不用传）。
5. 等几秒，Glitch 会自动执行 `npm start`（即 `node server.js`）。看底部 **Logs** 面板出现"坦克动荡 服务器已启动"即成功。
6. 点左上角项目名（铅笔图标）可改项目名，网址为 `https://项目名.glitch.me` —— **这就是永久网址**，发给任何人即可玩。
> 注意：免费项目代码公开可见（不含隐私数据，无需介意）；几分钟不访问会休眠，打开时自动唤醒。

### 方案 B：Render（推荐，免费固定网址，需 GitHub）
1. 注册 [render.com](https://render.com)（GitHub 账号直接登录）。
2. **把 `tank-game` 文件夹单独作为一个仓库推送到 GitHub**（`render.yaml` 必须在仓库根目录！可以用桌面版 GitHub 客户端，或网页上传 zip 的方式建仓库）。
3. Render 控制台 → **New + → Web Service** → 连接你的 GitHub 仓库（授权后选择它）。
4. 平台自动读取 `render.yaml`，你只需要确认：
   - **Runtime**: Node
   - **Build Command**: 留空
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
5. 点 **Create Web Service**。等约 1-2 分钟构建部署完成，状态变 **Live**。
6. 点服务页顶部的链接（形如 `https://tank-turmoil.onrender.com`）即可访问。
> 免费实例闲置 15 分钟休眠，首次访问等约 30 秒自动唤醒。

### 方案 C：Render + Gitee（国内不用 GitHub 也可以）
1. 把 `tank-game` 文件夹传到 [Gitee 码云](https://gitee.com) 的**公开仓库**（同样要求 `render.yaml` 在根目录）。
2. Render 创建 Web Service 时选择 **Public Git Repository**，粘贴 Gitee 仓库地址，其余同方案 B。

### 方案 D：Tailscale Funnel（免费，用你自己的电脑当服务器）
1. 双方安装 [Tailscale](https://tailscale.com)，登录同一账号。
2. 开服务器的电脑执行 `tailscale funnel 8123`。
3. 得到固定网址 `https://<机器名>.<tailnet>.ts.net`，无需部署、无需公网 IP。
> 缺点：你的电脑必须开机运行 `server.js`。

### 方案 E：动态域名 + 端口转发（国内可用）
路由器把公网端口转发到电脑 8123，再用花生壳/阿里云 DDNS 绑定一个固定域名指向你的公网 IP。

### 打不开？排查步骤
1. **看 Logs**：Render 服务页 → **Logs** 标签（或 Glitch 底部 Logs）。启动成功会打印"坦克动荡 服务器已启动 / 监听端口: xxx"。若报错，把错误信息复制发给我。
2. **看状态**：Render 服务名旁边是 **Live** 才可访问；Deploying/Build failed 表示还在构建或构建失败（点 Deploy 旁边的日志看 Build 输出）。
3. **等冷启动**：免费实例休眠后首次访问要等 30-60 秒，期间浏览器一直转圈属正常。
4. **URL 确认**：Render 服务页顶部显示的才是你的网址（`https://<名字>.onrender.com`），不是模板里的 xxx。
5. **健康检查**：本服务 `/` 返回 200，无需额外配置。

> 部署到云端后，游戏内"开启公网联机"按钮会自动禁用（云端已设 `TK_TUNNEL_DISABLED=1`），网址本身就是公网直连。

## 如何联机

### 方式零：一键公网通道（最简单，推荐）
1. 创建房间后，在大厅点 **"🌐 开启公网联机"**。首次使用需下载 cloudflared 组件（约 50MB，已内置多镜像 + 断点续传；若已随包就位则秒开）。
2. 约 10 秒后，大厅会显示一个 `https://xxxx.trycloudflare.com/?room=房间号` 的公网链接（点"复制"）。
3. 把链接发给好友（微信/QQ 直接发），**任何人任何网络**打开即可加入，无需同网络、无需路由器设置。
4. 不玩了点"关闭公网联机"即可。
> 说明：公网链接由 Cloudflare 免费 Quick Tunnel 提供，每次开启生成新链接。
> 若自动下载始终失败（GitHub/镜像均受限）：用浏览器下载 https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe，改名为 `cloudflared.exe` 放入本程序 `bin` 目录，重新点开启即可（也可用 `node test-download.js` 重试自动下载）。
> 另注：某些网络环境对 Cloudflare 域名访问受限，可改用下方 Tailscale 方案。

### 方式一：局域网（免输房间号）
1. 开服务器的电脑运行 `node server.js`，记下打印的局域网地址。
2. 同一 Wi-Fi 下的人打开 `http://<局域网IP>:8123/`，主菜单的"局域网房间"列表会直接显示房间，**点一下即可加入**，无需房间号。
3. 若连不上：Windows 防火墙需放行 Node.js（首次启动时点"允许访问"，或在"防火墙高级设置"中放行端口 8123）。

### 方式二：互联网远程联机（备选）

| 方案 | 说明 |
| --- | --- |
| **Tailscale**（免费） | 双方安装 Tailscale 组成虚拟局域网，用 `http://<tailscale-IP>:8123/` 直连，无需公网 IP |
| **内网穿透**（ngrok / cloudflared 命令行） | 在开服务器电脑上执行 `ngrok http 8123`，把生成的公网 https 地址发给好友 |
| **路由器端口转发** | 路由器把公网端口转发到电脑的 8123，好友访问 `http://<公网IP>:端口/` |
| **云服务器部署** | 把整个文件夹上传到 VPS / 轻量服务器，执行 `node server.js`，然后开放安全组端口 |

> 提示：服务器必须保持运行，好友才能加入；网页端无需安装任何东西。

## 操作说明

### 电脑
| 按键 | 功能 |
| --- | --- |
| W / S 或 ↑ / ↓ | 前进 / 后退 |
| A / D 或 ← / → | 转向 |
| 鼠标 | 瞄准炮塔 |
| 左键 / 空格 | 开火（按住连射） |
| Shift | 加速 |
| M | 静音 |

### 手机（自动识别触屏，建议横屏）
| 操作 | 功能 |
| --- | --- |
| 左半屏拖动 | 虚拟摇杆：移动 / 转向 |
| 右半屏按住拖动 | 瞄准炮塔（按住即开火，轻点=向前开火） |
| 右下"加速"按钮 | 加速 |
| 竖屏时 | 会提示横屏游玩 |

> 手机端与电脑端可同场对战；菜单、公网链接、房间列表在手机上同样可用。

## 项目结构

```
tank-game/
├── server.js          # 游戏服务端（HTTP 静态服务 + WebSocket + 权威模拟 60Hz）
├── public/
│   ├── index.html     # 页面
│   ├── style.css      # 样式
│   └── game.js        # 客户端（本地预测 + 快照插值 + 渲染 + 音效）
├── test.js            # 自动化冒烟测试
├── start.cmd          # Windows 一键启动
└── README.md
```

## 技术要点

- 服务端权威模拟：60Hz 物理 tick，30Hz 快照广播；客户端对自己做本地预测（同款物理），对他人做 90ms 快照插值，保证手感与公平。
- WebSocket 为手写 RFC 6455 最小实现（文本帧 + 分片 + ping/pong 心跳），零依赖。
- 房间制：4 位房间码、房主开局、中途加入旁观、断线自动重连、空房自动回收。

## 自定义

- 房间人数上限：`server.js` 中 `MAX_PLAYERS`（默认 8）。
- 地图/物理参数：`server.js` 顶部 `WORLD / OBSTACLES / TANK / BULLET / POWERUP` 常量，客户端 `public/game.js` 中需同步修改同名常量。
- 浏览器要求：现代浏览器（Chrome / Edge / Firefox），桌面端体验最佳。

## 测试

```bash
node test.js   # 自动起临时服务器(端口8234)并验证 16 项核心流程
```
