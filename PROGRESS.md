# 坦克动荡 - 项目进度备忘

> 版本：v0.02.137 测试版（0.02.改动次数，136 = GitHub 提交总数）
> 最后更新：以色列梅卡瓦 + 俄军T90A干扰 + 反坦克导弹 + 中国99B主动防御 + 欧盟豹二A6

## 快速启动

- 本地服务器：`& 'F:\MOD\DeepSeek Harness-Setup-0.1.0\resources\node\node.exe' server.js`（默认端口 8123，测试用环境变量 PORT 指定）
- 线上地址：https://tank-game-rqu9.onrender.com/ （Render 免费实例，新加坡，~85ms）
- 代码仓库：hongjiangfeng37-ops/tank-game（用 gh CLI 推送：`F:\MOD\deep seek 工作区\tools\gh\bin\gh.exe`，**直连可用，无需代理**；Clash 代理 7897 端口可能未开）

## 文件结构

- `server.js`：全部服务器逻辑（权威模拟，60Hz tick）
- `public/game.js`：客户端（预测+插值渲染、SVG 坦克贴图、触屏 UI）
- `public/index.html` / `public/style.css`：页面与样式
- `lib-maze.js`：随机迷宫 / `lib-geom.js`：线段碰撞
- 测试脚本（同目录）：test.js / test-walls.js / test-wallshot.js / test-armor.js / test-selfhit.js / test-facing.js / test-hitcrash.js / test-bounce-render.js / test-facing-render.js / test-online.js（CDP 被安全软件拦，尽量不用）

## 核心玩法系统（已实现）

1. **装甲×穿深**：美 600/200/400、俄 800/250/700；穿深 美800(反弹-100) / 俄750(反弹-200)
2. **爆反(ERA)血条**：美 300、俄 500；**首次命中扣 40-70 随机，后续每次扣 20-40**；耗尽后装甲回基础值
   - 爆反存在时：美 900/800/400、俄 1200/1050/700
3. **90% 区间**：未击穿但达到 90% → 损坏命中部位模块不致死（正面：美履带/炮塔、俄履带/装弹机；背面：起火或发动机；侧面：美军履带/炮塔随机）
4. **弹药架弱点**：美=炮塔尾舱(rx<-13,|ry|<13)；俄=侧面中心(|ry|>17,|rx|<13) 命中必殉爆（先起火再爆）
5. **模块**：track/turret/engine/ammo/optics/loader（loader 仅俄军）；美军无装弹机
6. **美军炮塔**：爆反不满血时**正面击穿 15% 坏炮塔**（并入击穿判定，未击穿/跳弹一律不坏炮塔）；侧面击穿 40%；90% 区间正面只坏履带
7. **殉爆概率**（非弱点）：爆反时 侧面3%/背面10%；无爆反 侧面15%/背面40%
8. **自伤**：反弹炮弹可打到自己
9. **炮塔自动对齐**：无瞄准输入时 ta 跟随车体（autoTurret）
10. **观瞄损坏迷雾**：平时无迷雾；观瞄坏后全黑+坦克周围 70px 光；小地图敌人变模糊闪烁点
11. **手机操作**：左十字键移动、右摇杆纯瞄准（不自动开火）、独立开火键 btnFire；小地图右上角小尺寸
12. **AI 智能战斗（v4）**：A* 寻路导航（80px 网格、0.4s 无条件重算、路径简化+提前转向）、身法摆角、弹道规避、侧翼包抄打弱点、主动反弹射击（世界墙+障碍边）、道具拾取、撤退维修、卡点脱困（lowSpeedT+unstick 换边）。固定地图导航 100%、随机迷宫 ~90%（60-90s 内接近玩家 500px 内并命中）
13. **子弹出生保护**：出膛 200ms 内不判定命中发射者自己（修斜射吞炮弹 bug，服务器+客户端同步）
14. **布局设置**：主页"⚙️ 布局设置"或战斗中 ⚙ 按钮 → 拖动十字键/开火键/加速键/小地图调位置、滑块调大小，localStorage 保存（key tank.gameLayout.v1）；自测 ?layouttest=1（本地 11/11 过）
15. **安卓套壳 App**：android/ 目录（WebView 加载线上 URL，横屏全屏、常亮、沉浸式、localStorage 持久化布局设置）；GitHub Actions（.github/workflows/android-build.yml）自动构建 APK ✓（artifact tank-game-apk）
16. **日军 90式主战坦克**（jp）：穿深 500（**反弹 +100，最高反弹 9 次后消失**，与美俄反弹扣穿深不混淆——炮弹固化 ownerType 判断）；装甲 550/150/250，爆反 +200 → 爆反时 800/400/500；**尾舱弹药架直接殉爆**（同美军 rx<-13&&|ry|<13）；**前置弹药架起火**：爆反不满血时正面击穿 50% 弹药架起火（am 标记剧烈特效，有爆反满血不起火）；三色迷彩（茶/绿/黑）方形炮塔贴图；装填 5s
17. **弹药架起火特效**：快照 am 字段 + fire 事件 am 标记 → 客户端大火柱+火星+黑烟特效 + "💥 弹药架起火了"提示
18. **以军 梅卡瓦Mk4**（il）：发动机前置（没坏时全部位 +200 装甲）；弹药架正后方（**只起火不殉爆**，任何部位不殉爆）；炮塔损坏触发弹药架起火；**专属迫击炮**（静止 3s 锁定 + 周围敌人 1100px，无视地形，命中扣 30% 爆反，冷却 8s，被 T90A 干扰则锁定打断）；速度 225；爆反 200（与日军同）、加成比美军少 50（850/800/450）
19. **俄军 T90A**（更名 + 侧面 300）：**窗帘主动干扰**——炮塔前方 ±50°/700px 扇形：打断梅卡瓦迫击炮锁定、反坦克导弹原路返回；干扰激活时车体**红点眼睛发光**；车体外层爆反分层 + 新涂装
20. **反坦克导弹道具**（atgm）：拾取 1 发（无时间限制），B 键/手机导弹键发射；穿深 1500、慢速 260px/s、直线、撞墙消失；被 T90A 干扰原路返回
21. **中国 99B**（cn）：全场最快 290；穿深 850（反弹-50）；装甲 1000/150/650，爆反+450（1450/600/1100）；**主动防御系统**（E 键开启，2 次充能，抵挡一次攻击/开启 10s，用完 60s 冷却恢复，**炮塔损坏则失效**）；侧面弹药架必殉爆；沙色涂装 + 炮塔背面/车尾侧面格栅装甲
22. **欧盟 豹二A6**（de）：装甲/爆反同美军；弹药架同日（尾舱殉爆 + 前置起火）；穿深 800 **反弹不扣穿深，最多反弹 2 次**；德斑迷彩 + 楔形炮塔

## 测试运行

```
node test.js            # 协议
node test-walls.js      # 不穿墙+装填
node test-wallshot.js   # 贴墙禁火
node test-armor.js      # 装甲/穿深/爆反/90%区间（TK_ERA_SCALE=0.2）
node test-selfhit.js    # 自伤
node test-facing.js     # 移动方向==a
node test-hitcrash.js   # 命中不崩溃
node test-solo.js       # 单人模式 AI
node test-ai-nav.js     # AI 寻路导航（RANDOM=1 随机迷宫）
node test-live-smoke.js # 线上冒烟（Render）
node test-live-ai.js    # 线上 AI 行为
node test-bounce-render.js  # 反弹渲染完整（无 CDP）
node test-facing-render.js  # 朝向+迷雾（无 CDP，Edge headless ?facing=1）
```
注意：本地环境安全软件把 Node 定时器拖慢到 ~35Hz，测试要留足超时；Edge CDP 被 RST（需 --remote-allow-origins=* 且仍可能断）。

## 部署流程

1. `gh api repos/hongjiangfeng37-ops/tank-game/contents/<path> --jq '.sha'` 取当前 sha
2. base64 内容 + sha，`gh api -X PUT .../contents/<path> --input -`
3. 等 ~130s，验证 https://tank-game-rqu9.onrender.com/ 200

最近一次部署：`2bce3f2`（server.js 平衡性）、`d204ce3`（game.js）、`927ed93`（index.html）——俄军侧面 250/爆反1050、弹药架区域收窄、殉爆概率降低、美军正面 75% 侧面 40% 坏炮塔、侧面 90% 区间 track/turret。

## 待办 / 用户可能继续提的需求

- 无（当前用户反馈已全部处理）
- 用户偏好：中文回复、简洁不道歉、不乱删东西
