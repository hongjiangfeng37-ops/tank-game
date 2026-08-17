#!/usr/bin/env node
'use strict';
/*
 * 坦克动荡（多人联机版）—— 游戏服务端
 * 纯 Node.js 标准库实现，零外部依赖。
 * 启动: node server.js [端口]   （默认 8123，若被占用会自动尝试 8124..8135）
 * 页面: http://<本机IP>:<端口>/    WebSocket: /ws
 *
 * 架构：服务端权威模拟（60Hz tick，30Hz 快照广播），客户端做本地预测 + 快照插值。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { downloadCloudflared } = require('./lib-download');
const { segRectHit } = require('./lib-geom');
const { generateMaze, fitSpawn } = require('./lib-maze');

// ---------------- 配置 ----------------
const WANTED_PORT = parseInt(process.env.PORT || process.argv[2] || '8123', 10);
const MAX_PORT_TRIES = 13;
const PUBLIC_DIR = path.join(__dirname, 'public');
const WS_PATH = '/ws';
const MAX_PLAYERS = 8;
const TICK_MS = 1000 / 60;
const SNAP_EVERY = 1;          // 每 tick 广播一次快照 => 60Hz（更低延迟）
const PING_EVERY = 20000;      // ws 心跳间隔
const ALIVE_TIMEOUT = 90000;   // 心跳超时（宽容：手机切后台/网络抖动不误杀）
const MAX_MSG = 1 << 20;       // 单条消息上限 1MB

// ---------------- 世界常量（与 public/game.js 保持一致） ----------------
const WORLD = { w: 1600, h: 1200 };
const WALL_T = 24; // 墙厚（碰撞边界在墙内缘）
// 迷宫参数：每回合随机生成新迷宫（DFS 完美迷宫，通道全部连通）
const MAZE_COLS = 8, MAZE_ROWS = 6;  // 迷宫格子少而大：通道 ~180px，适配真实比例长坦克
const MAZE_WALL = 20; // 迷宫隔墙厚度
// 固定地图（测试模式 TK_FIXED_MAP=1 使用，生产环境每回合随机迷宫）
const DEFAULT_OBSTACLES = [
  { x: 330, y: 240, w: 240, h: 150 },
  { x: 1030, y: 240, w: 240, h: 150 },
  { x: 330, y: 810, w: 240, h: 150 },
  { x: 1030, y: 810, w: 240, h: 150 },
  { x: 700, y: 525, w: 200, h: 150 },
];
const SPAWNS = [
  { x: 130, y: 130, a: Math.PI / 4 },
  { x: 1470, y: 130, a: -Math.PI / 4 },
  { x: 130, y: 1070, a: (3 * Math.PI) / 4 },
  { x: 1470, y: 1070, a: -(3 * Math.PI) / 4 },
  { x: 800, y: 110, a: Math.PI / 2 },
  { x: 800, y: 1090, a: -Math.PI / 2 },
  { x: 110, y: 600, a: 0 },
  { x: 1490, y: 600, a: Math.PI },
];
// 坦克尺寸（52x44 原版比例，SAT 旋转矩形碰撞轴 rx/ry）
const TANK = { rx: 26, ry: 22, l: 52, w: 44, accel: 340, turn: 3.2, dragF: 0.9, dragL: 3.8, hp: 100, boostMult: 1.3 };
// 坦克类型（玩家开局选择）
// 装甲厚度：armor 基础 / armorEra 爆反生效时；穿深：pen 初始，每次反弹扣 penDrop，扣完消失
const TANK_TYPES = {
  us: {
    name: '美军 M1A1标题党', maxSpeed: 270, back: 0.8, reload: 4,
    era: 300,                                        // 爆反血量（命中伤害/2 扣除，扣完失效）
    armor: { front: 600, side: 200, back: 400 },     // 基础装甲
    armorEra: { front: 900, side: 800, back: 400 },  // 爆反生效时装甲（背面不变）
    pen: 800, penDrop: 100,                          // 初始穿深 / 每次反弹衰减
    ammoZone: 'rear',   // 弹药架位于炮塔后方
    hasLoader: false,
  },
  ru: {
    name: '俄军 T80U', maxSpeed: 205, back: 0.35, reload: 6,
    era: 500,                                       // 爆反血量（俄军比美军多 200：300+200）
    armor: { front: 800, side: 250, back: 700 },    // 侧面基础装甲 150→250（爆反耗尽后不纸糊）
    armorEra: { front: 1200, side: 1050, back: 700 },  // 爆反侧面额外防护 +800（250→1050）
    pen: 750, penDrop: 200,
    ammoZone: 'side',   // 弹药架位于侧面中心
    hasLoader: true,    // 自动装弹机：损坏后装填时间翻倍
  },
  jp: {
    name: '日军 90式主战坦克', maxSpeed: 280, back: 0.6, reload: 3,
    era: 200,                                       // 爆反血量（用户指定 200）
    armor: { front: 550, side: 150, back: 250 },    // 基础装甲
    armorEra: { front: 800, side: 400, back: 500 }, // 爆反生效时（每部位 +250）
    pen: 500, penGain: 200, penBounceMax: 9,        // 特殊：每次反弹穿深 +200，最高反弹 9 次后消失
    ammoZone: 'rear',   // 尾舱弹药架：直接殉爆（同美军）
    frontAmmoFire: true, // 前置弹药架：爆反不满血时正面击穿 50% 弹药架起火
    hasLoader: false,
  },
};
// 反弹后的穿深处理：普通坦克扣穿深；90式反弹增加穿深（最高 9 次后消失）；返回 true = 子弹消失
// 用炮弹上固化的 ownerType 判断（不查 room.players——射手离场后仍按原类型处理，杜绝机制混淆）
function applyBouncePen(b, room) {
  const bt = TANK_TYPES[b.ownerType];
  if (bt && bt.penGain) {
    b.penBounces = (b.penBounces || 0) + 1;
    b.pen += bt.penGain;
    return b.penBounces >= bt.penBounceMax;
  }
  const penDrop = bt ? bt.penDrop : 100;
  b.pen -= penDrop;
  return b.pen <= 0;
}
const BULLET = { speed: 620, r: 5, dmg: 30, life: 5.5, cooldown: 0.35, rapidCd: 0.14 };
const MAG_SIZE = 1;        // 弹匣容量（单发装填）
const PARTS_LIST = ['track', 'turret', 'engine', 'ammo', 'optics', 'loader']; // 可损坏部件（loader 仅俄军）
const FRONT_PARTS = ['track', 'turret', 'engine', 'optics'];         // 正面命中不会直接坏弹药架
const REPAIR_TIME = 2.5;   // 停车维修一个部件所需秒数
const FIRE_TIME = 3;       // 起火持续秒数
const FIRE_DPS = 5;        // 起火每秒伤害
const POWERUP = { max: 4, spawnEvery: 6, life: 20, r: 15 };
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 初始爆反血量（TK_ERA_SCALE 测试钩子：缩小血量以便快速验证爆反失效后的判定）
function initialEra(type) {
  const base = TANK_TYPES[type].era;
  const scale = Number(process.env.TK_ERA_SCALE);
  return Number.isFinite(scale) && scale > 0 ? Math.max(1, Math.round(base * scale)) : base;
}

// 生成当前回合的地图（测试模式用固定布局，生产每回合随机迷宫）
function roomMap() {
  return process.env.TK_FIXED_MAP === '1' ? DEFAULT_OBSTACLES.map((o) => ({ ...o })) : generateMaze(MAZE_COLS, MAZE_ROWS, WORLD.w, WORLD.h, MAZE_WALL);
}

// ---------------- 工具函数 ----------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const normAngle = (a) => { a %= Math.PI * 2; return a < 0 ? a + Math.PI * 2 : a; };
const rnd = (n) => Math.floor(Math.random() * n);
function weightedPick(weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}
function insideObstacle(x, y, pad, obstacles) {
  for (const o of obstacles) {
    if (x >= o.x - pad && x <= o.x + o.w + pad && y >= o.y - pad && y <= o.y + o.h + pad) return true;
  }
  return false;
}
function sanitizeName(name) {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return s || '无名玩家';
}

// ---------------- WebSocket 帧编解码（RFC 6455 最小实现） ----------------
function wsFrame(opcode, payload, masked) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  if (masked) {
    header[1] |= 0x80;
    const mask = crypto.randomBytes(4);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, out]);
  }
  return Buffer.concat([header, payload]);
}

function handleFrame(conn, fin, opcode, payload) {
  if (opcode === 0x8) { // close
    try { conn.socket.write(wsFrame(0x8, payload, false)); } catch (e) { /* ignore */ }
    conn.die();
    return;
  }
  if (opcode === 0x9) { // ping -> pong
    try { conn.socket.write(wsFrame(0xa, payload, false)); } catch (e) { /* ignore */ }
    return;
  }
  if (opcode === 0xa) return; // pong
  if (opcode === 0x1 || opcode === 0x0) {
    if (opcode === 0x1 && fin) { onMessage(conn, payload); return; }
    if (opcode === 0x1) { conn.msgParts = [payload]; return; }
    if (opcode === 0x0) {
      if (!conn.msgParts) return;
      conn.msgParts.push(payload);
      if (fin) { const all = Buffer.concat(conn.msgParts); conn.msgParts = null; onMessage(conn, all); }
    }
  }
  // 其他 opcode（二进制等）忽略
}

function feed(conn, chunk) {
  conn.recvBuf = conn.recvBuf.length ? Buffer.concat([conn.recvBuf, chunk]) : chunk;
  let buf = conn.recvBuf;
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let hlen = 2;
    if (len === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(off + 2); hlen = 4;
    } else if (len === 127) {
      if (buf.length - off < 10) break;
      len = Number(buf.readBigUInt64BE(off + 2)); hlen = 10;
    }
    if (len > MAX_MSG) { conn.die(1009, 'too big'); return; }
    const maskLen = masked ? 4 : 0;
    if (buf.length - off < hlen + maskLen + len) break;
    const payload = Buffer.from(buf.slice(off + hlen + maskLen, off + hlen + maskLen + len));
    if (masked) {
      const key = buf.slice(off + hlen, off + hlen + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    }
    off += hlen + maskLen + len;
    handleFrame(conn, fin, opcode, payload);
    if (conn.dead) return;
  }
  conn.recvBuf = off > 0 ? buf.slice(off) : buf;
}

function makeConn(socket) {
  const conn = {
    socket,
    recvBuf: Buffer.alloc(0),
    msgParts: null,
    player: null,
    aliveAt: Date.now(),
    dead: false,
    die(code) {
      if (conn.dead) return;
      conn.dead = true;
      if (code) { try { socket.write(wsFrame(0x8, Buffer.from(''), false)); } catch (e) { /* ignore */ } }
      socket.destroy();
    },
  };
  socket.on('data', (d) => { conn.aliveAt = Date.now(); feed(conn, d); });
  socket.on('error', () => { /* ignore */ });
  socket.on('close', () => {
    if (conn.dead) return;
    conn.dead = true;
    if (conn.player) {
      const p = conn.player;
      conn.player = null;
      // 断线保留机制：玩家保留 15 秒等待重连恢复（坦克不消失、不变旁观）
      p.conn = null;
      p.disconnected = true;
      p.disconnectedAt = Date.now();
      // 清零输入，防止断线坦克按最后指令继续行驶
      p.input = { thr: 0, steer: 0, ta: p.input.ta, shoot: false, boost: false };
      if (p.room) {
        p.room.pendingEvents.push({ k: 'leave', name: p.name });
        broadcastRoom(p.room);
        clearTimeout(p.removeTimer);
        p.removeTimer = setTimeout(() => {
          if (p.disconnected) removePlayer(p.room, p);
        }, 15000);
      }
    }
  });
  return conn;
}

// ---------------- 房间与玩家 ----------------
const rooms = new Map(); // code -> room
let nextPlayerId = 1;

function genCode() {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += ROOM_CHARS[rnd(ROOM_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return String(Date.now()).slice(-6);
}

function roster(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, alive: p.alive, host: p.id === room.hostId, type: p.type, bot: !!p.isBot }));
}
function scores(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, kills: p.kills, wins: p.wins, alive: p.alive }));
}

function makeRoom(conn, name) {
  const code = genCode();
  const room = {
    code,
    players: new Map(),
    hostId: null,
    phase: 'lobby',          // lobby | countdown | play | over
    phaseT: 0,
    winner: null,
    roundNo: 0,
    obstacles: roomMap(), // 本回合地图（生产每回合随机迷宫）
    spawns: SPAWNS.map((s) => ({ ...s })),
    bullets: [],
    pups: [],
    pupTimer: 4,
    tick: 0,
    pendingEvents: [],
  };
  rooms.set(code, room);
  addPlayer(room, conn, name);
  return room;
}

function addPlayer(room, conn, name) {
  const id = 'p' + (nextPlayerId++);
  const p = {
    id, name, conn, room,
    tank: null, alive: false, deadAt: 0,
    kills: 0, wins: 0,
    type: 'us', era: TANK_TYPES.us.era,
    shield: false, rapid: 0, triple: 0, fireCd: 0,
    parts: { track: true, turret: true, engine: true, ammo: true, optics: true, loader: true },
    repairT: 0, fireT: 0, fireDmg: 0,
    input: { thr: 0, steer: 0, ta: null, shoot: false, boost: false },
  };
  room.players.set(id, p);
  conn.player = p;
  if (!room.hostId) room.hostId = id;
  if (room.phase === 'countdown') spawnPlayer(room, p);
  send(conn, {
    t: 'hello', id, name, code: room.code, hostId: room.hostId,
    phase: room.phase, phaseT: Math.round(room.phaseT * 10) / 10, winner: room.winner,
    lan: lanHint(),
    publicUrl: tunnel.state === 'on' ? tunnel.url : null,
    map: room.obstacles,
    players: roster(room),
    scores: scores(room),
  });
  room.pendingEvents.push({ k: 'join', name: p.name });
  broadcastRoom(room);
  broadcast(room); // 立刻给新玩家一帧快照
  return p;
}

// 单人模式 AI：服务器内部玩家（无连接），行为在 sim 中由 botThink 驱动
function addBot(room, name) {
  const id = 'p' + (nextPlayerId++);
  const p = {
    id, name, conn: null, room, isBot: true,
    tank: null, alive: false, deadAt: 0,
    kills: 0, wins: 0,
    type: 'ru', era: TANK_TYPES.ru.era, // 默认俄军；玩家选型后自动取相反型号
    shield: false, rapid: 0, triple: 0, fireCd: 0,
    parts: { track: true, turret: true, engine: true, ammo: true, optics: true, loader: true },
    repairT: 0, fireT: 0, fireDmg: 0,
    input: { thr: 0, steer: 0, ta: null, shoot: false, boost: false },
  };
  room.players.set(id, p);
  if (room.phase === 'countdown') spawnPlayer(room, p);
  room.pendingEvents.push({ k: 'join', name: p.name });
  broadcastRoom(room);
  broadcast(room);
  return p;
}

// ---- AI 寻路：80px 网格 A*（迷宫通道导航，杜绝卡墙角；路径点稀疏减少频繁转向） ----
const NAV_CELL = 80, NAV_COLS = 20, NAV_ROWS = 15, NAV_PAD = 40, NAV_PAD_TIGHT = 32;
function navWalkable(room, gx, gy, pad) {
  const cx = NAV_CELL / 2 + gx * NAV_CELL;
  const cy = NAV_CELL / 2 + gy * NAV_CELL;
  if (cx < WALL_T + 48 || cx > WORLD.w - WALL_T - 48 || cy < WALL_T + 48 || cy > WORLD.h - WALL_T - 48) return false;
  if (insideObstacle(cx, cy, pad, room.obstacles)) return false;
  return true;
}
function navGridToXY(gx, gy) { return { x: NAV_CELL / 2 + gx * NAV_CELL, y: NAV_CELL / 2 + gy * NAV_CELL }; }
function navXYToGrid(x, y) {
  return {
    gx: Math.max(0, Math.min(NAV_COLS - 1, Math.round((x - NAV_CELL / 2) / NAV_CELL))),
    gy: Math.max(0, Math.min(NAV_ROWS - 1, Math.round((y - NAV_CELL / 2) / NAV_CELL))),
  };
}
// 路径简化：贪心视线简化（保留必要转弯点；线段按坦克半宽 18px 膨胀检测，防擦障碍角）
function simplifyPath(room, pts) {
  if (pts.length <= 2) return pts;
  const hitInflated = (x0, y0, x1, y1, o) => segRectHit(x0, y0, x1, y1, { x: o.x - 26, y: o.y - 26, w: o.w + 52, h: o.h + 52 });
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let best = i + 1;
    for (let j = i + 2; j < pts.length; j++) {
      let clear = true;
      for (const o of room.obstacles) {
        if (hitInflated(pts[i].x, pts[i].y, pts[j].x, pts[j].y, o)) { clear = false; break; }
      }
      if (clear) best = j; else break;
    }
    out.push(pts[best]);
    i = best;
  }
  return out;
}
// 返回世界坐标路径点数组（含起点终点）；终点不可行时自动找最近可行格；pad 为障碍膨胀半径
function navFindPath(room, sx, sy, tx, ty, pad) {
  const s = navXYToGrid(sx, sy);
  let t = navXYToGrid(tx, ty);
  // 终点格不可行 → 环形搜索最近可行格（半径递增；终点用更紧 pad 30，让路径直达目标附近）
  const tPad = Math.min(pad, 30);
  if (!navWalkable(room, t.gx, t.gy, tPad)) {
    let found = null;
    for (let r = 1; r <= 7 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const ngx = t.gx + dx, ngy = t.gy + dy;
          if (ngx < 0 || ngy < 0 || ngx >= NAV_COLS || ngy >= NAV_ROWS) continue;
          if (navWalkable(room, ngx, ngy, tPad)) { found = { gx: ngx, gy: ngy }; break; }
        }
      }
    }
    if (!found) return null;
    t = found;
  }
  // 起点格不可行 → 同样找最近可行格
  let s2 = s;
  if (!navWalkable(room, s.gx, s.gy, pad)) {
    let found = null;
    for (let r = 1; r <= 4 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const ngx = s.gx + dx, ngy = s.gy + dy;
          if (ngx < 0 || ngy < 0 || ngx >= NAV_COLS || ngy >= NAV_ROWS) continue;
          if (navWalkable(room, ngx, ngy, pad)) { found = { gx: ngx, gy: ngy }; break; }
        }
      }
    }
    if (found) s2 = found;
  }
  const W = NAV_COLS, H = NAV_ROWS;
  const g = new Float64Array(W * H); g.fill(Infinity);
  const came = new Int32Array(W * H); came.fill(-1);
  const closed = new Uint8Array(W * H);
  const open = [];
  const si = s2.gy * W + s2.gx;
  g[si] = 0;
  open.push({ f: Math.hypot(s2.gx - t.gx, s2.gy - t.gy), gx: s2.gx, gy: s2.gy });
  const dirs = [[1,0],[0,1],[-1,0],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  const dc = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142];
  let found = null;
  let guard = 0;
  while (open.length && guard++ < 9000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ci = cur.gy * W + cur.gx;
    if (cur.gx === t.gx && cur.gy === t.gy) { found = cur; break; }
    if (closed[ci]) continue;
    closed[ci] = 1;
    for (let d = 0; d < 8; d++) {
      const nx = cur.gx + dirs[d][0], ny = cur.gy + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (!navWalkable(room, nx, ny, pad)) continue;
      // 对角移动禁止"穿角"：相邻两个轴向格都须可行（防路径斜穿障碍角卡住）
      if (d >= 4 && (!navWalkable(room, cur.gx + dirs[d][0], cur.gy, pad) || !navWalkable(room, cur.gx, cur.gy + dirs[d][1], pad))) continue;
      const ni = ny * W + nx;
      if (closed[ni]) continue;
      const ng = g[ci] + dc[d];
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = ci;
        open.push({ f: ng + Math.hypot(nx - t.gx, ny - t.gy), gx: nx, gy: ny });
      }
    }
  }
  if (!found) return null;
  const pts = [];
  let ci = t.gy * W + t.gx;
  while (ci !== -1) {
    pts.push(navGridToXY(ci % W, Math.floor(ci / W)));
    ci = came[ci];
  }
  pts.reverse();
  return simplifyPath(room, pts);
}

// 找反弹射击角度：世界墙 + 障碍物矩形边（镜像反射法）；返回瞄准角度或 null
function findBankAim(room, tk, tt) {
  // 世界墙反射
  const walls = [
    { vert: true, val: WALL_T }, { vert: true, val: WORLD.w - WALL_T },
    { vert: false, val: WALL_T }, { vert: false, val: WORLD.h - WALL_T },
  ];
  for (const w of walls) {
    const pd = w.vert ? Math.abs(tt.x - w.val) : Math.abs(tt.y - w.val);
    if (pd > 160) continue;
    const mx = w.vert ? 2 * w.val - tt.x : tt.x;
    const my = w.vert ? tt.y : 2 * w.val - tt.y;
    let ix, iy;
    if (w.vert) {
      if (Math.abs(mx - tk.x) < 1) continue;
      const t = (w.val - tk.x) / (mx - tk.x);
      if (t <= 0.04 || t >= 0.96) continue;
      iy = tk.y + t * (my - tk.y);
      if (iy < WALL_T + 40 || iy > WORLD.h - WALL_T - 40) continue;
      ix = w.val;
    } else {
      if (Math.abs(my - tk.y) < 1) continue;
      const t = (w.val - tk.y) / (my - tk.y);
      if (t <= 0.04 || t >= 0.96) continue;
      ix = tk.x + t * (mx - tk.x);
      if (ix < WALL_T + 40 || ix > WORLD.w - WALL_T - 40) continue;
      iy = w.val;
    }
    let clear = true;
    for (const o of room.obstacles) {
      if (segRectHit(tk.x, tk.y, ix, iy, o) || segRectHit(ix, iy, tt.x, tt.y, o)) { clear = false; break; }
    }
    if (clear) return Math.atan2(my - tk.y, mx - tk.x);
  }
  // 障碍物矩形边反射（迷宫墙反弹打玩家）
  for (const o of room.obstacles) {
    // 快速跳过：矩形远离双方（<380px 才可能构成反射路径）
    const nearBot = tk.x > o.x - 380 && tk.x < o.x + o.w + 380 && tk.y > o.y - 380 && tk.y < o.y + o.h + 380;
    const nearTgt = tt.x > o.x - 380 && tt.x < o.x + o.w + 380 && tt.y > o.y - 380 && tt.y < o.y + o.h + 380;
    if (!nearBot || !nearTgt) continue;
    const edges = [
      { ax: o.x, ay: o.y, bx: o.x + o.w, by: o.y, nx: 0, ny: -1 },
      { ax: o.x, ay: o.y + o.h, bx: o.x + o.w, by: o.y + o.h, nx: 0, ny: 1 },
      { ax: o.x, ay: o.y, bx: o.x, by: o.y + o.h, nx: -1, ny: 0 },
      { ax: o.x + o.w, ay: o.y, bx: o.x + o.w, by: o.y + o.h, nx: 1, ny: 0 },
    ];
    for (const e of edges) {
      const ex0 = e.ax, ey0 = e.ay;
      // 双方必须在反射面外侧（法线侧）
      const toB = (tk.x - ex0) * e.nx + (tk.y - ey0) * e.ny;
      const toT = (tt.x - ex0) * e.nx + (tt.y - ey0) * e.ny;
      if (toB < 2 || toT < 2) continue;
      // 玩家镜像
      const mx = tt.x - 2 * toT * e.nx, my = tt.y - 2 * toT * e.ny;
      const dxl = mx - tk.x, dyl = my - tk.y;
      const denom = dxl * e.nx + dyl * e.ny;
      if (Math.abs(denom) < 1) continue;
      const t = ((ex0 - tk.x) * e.nx + (ey0 - tk.y) * e.ny) / denom;
      if (t <= 0.03 || t >= 0.97) continue;
      const ix = tk.x + t * dxl, iy = tk.y + t * dyl;
      if (ix < Math.min(e.ax, e.bx) - 1 || ix > Math.max(e.ax, e.bx) + 1 || iy < Math.min(e.ay, e.by) - 1 || iy > Math.max(e.ay, e.by) + 1) continue;
      let clear = true;
      for (const o2 of room.obstacles) {
        if (o2 === o) continue;
        if (segRectHit(tk.x, tk.y, ix, iy, o2) || segRectHit(ix, iy, tt.x, tt.y, o2)) { clear = false; break; }
      }
      if (clear) return Math.atan2(my - tk.y, mx - tk.x);
    }
  }
  return null;
}

// AI 行为：智能战斗（状态机）——A* 寻路导航 + 身法摆角 + 弹道规避 + 侧翼包抄打击弱点 + 主动反弹射击 + 道具拾取 + 撤退维修
// 目标是难以战胜：不卡墙角、精准提前量射击、机动躲炮弹、绕到玩家侧后打弱点、被打坏了会拉开距离修车再战
function botThink(p, room, dt) {
  const tk = p.tank;
  const ai = p.ai || (p.ai = {
    mode: 'combat', strafeT: Math.random() * 2, flankDir: 1, flankT: 1,
    dodgeDir: 1, evadeT: 0, shootT: 0, thinkT: 0,
    unstickT: 0, unstickDir: 1, unstickCd: 0, lowSpeedT: 0, rayFollow: false, followSteer: 1,
  });
  ai.strafeT += dt;
  ai.shootT -= dt;
  ai.evadeT -= dt;
  ai.flankT -= dt;
  ai.thinkT -= dt;
  ai.unstickT -= dt;
  if (ai.flankT <= 0) { ai.flankT = 1.5 + Math.random() * 1.4; ai.flankDir = Math.random() < 0.5 ? 1 : -1; }

  // 目标：优先真人，否则其他 bot
  let target = null;
  for (const q of room.players.values()) if (!q.isBot && q.alive && q.tank) { target = q; break; }
  if (!target) for (const q of room.players.values()) if (q.id !== p.id && q.alive && q.tank) { target = q; break; }
  if (!target) { p.input = { thr: 0, steer: 0, ta: tk.ta, shoot: false, boost: false }; return; }
  const tt = target.tank;
  const dx = tt.x - tk.x, dy = tt.y - tk.y;
  const dist = Math.hypot(dx, dy);
  const angTo = Math.atan2(dy, dx);
  const angDiff = (a) => { let d = a - tk.a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  const sightClear = (x0, y0, x1, y1) => { for (const o of room.obstacles) if (segRectHit(x0, y0, x1, y1, o)) return false; return true; };

  const parts = p.parts;
  const brokenCount = PARTS_LIST.filter((n) => !parts[n]).length;
  const lowHp = tk.hp < 50;
  const needRepair = brokenCount > 0 && (brokenCount >= 2 || (lowHp && brokenCount > 0));
  if (process.env.TK_AI_DEBUG === '1' && room.tick % 30 === 0) {
    console.log('[AI] t=' + room.tick + ' pos=' + Math.round(tk.x) + ',' + Math.round(tk.y) +
      ' mode=' + ai.mode + ' dist=' + Math.round(dist) + ' broken=' + brokenCount +
      ' projV=' + Math.round(tk.vx * Math.cos(tk.a) + tk.vy * Math.sin(tk.a)) +
      ' lowT=' + Math.round((ai.lowSpeedT || 0) * 100) + ' uc=' + Math.round((ai.unstickCd || 0) * 100));
  }

  // ---- 撤退维修状态：拉开距离停车修车（修好再战） ----
  if (ai.mode === 'repair') {
    if (brokenCount === 0) { ai.mode = 'combat'; }
    else {
      if (dist < 400) {
        const away = angTo + Math.PI;
        const dd = angDiff(away);
        p.input = { thr: 1, steer: dd > 0.15 ? 1 : (dd < -0.15 ? -1 : 0), ta: angTo, shoot: false, boost: true };
      } else if (dist > 560) {
        p.input = { thr: 0, steer: 0, ta: angTo, shoot: false, boost: false }; // 完全静止修车
      } else {
        const away = angTo + Math.PI;
        const dd = angDiff(away);
        p.input = { thr: 1, steer: dd > 0.15 ? 1 : (dd < -0.15 ? -1 : 0), ta: angTo, shoot: false, boost: false };
      }
      return;
    }
  }
  if (needRepair && dist < 480) ai.mode = 'repair';

  // ---- 弹道规避：预测炮弹轨迹，横向急加速闪避（每 tick 检测，可连续触发） ----
  let threat = null, threatPos = null;
  for (const b of room.bullets) {
    if (b.ownerId !== target.id) continue;
    const bx = b.x - tk.x, by = b.y - tk.y;
    const bd = Math.hypot(bx, by);
    if (bd > 430 || bd < 10) continue;
    const spd = Math.hypot(b.vx, b.vy) || 1;
    const dot = (b.vx * -bx + b.vy * -by) / (spd * bd);
    if (dot > 0.72) {
      threat = b;
      // 预测炮弹 0.3s 后的位置（闪避远离点）
      threatPos = { x: b.x + b.vx * 0.3, y: b.y + b.vy * 0.3 };
      break;
    }
  }
  if (threat) {
    ai.evadeT = Math.max(ai.evadeT, 0.5); // 持续威胁则持续闪避
    if (ai.thinkT <= 0) {
      const cross = threat.vx * (tk.y - threat.y) - threat.vy * (tk.x - threat.x);
      ai.dodgeDir = cross > 0 ? 1 : -1;
    }
  }
  const evading = ai.evadeT > 0;

  // ---- 开火瞄准：提前量预测（按炮弹飞行时间）+ 视线检查 + 主动反弹（直线被挡时找反射路径） ----
  const lead = Math.min(0.6, dist / 620 * 0.92);
  const aimX = tt.x + tt.vx * lead, aimY = tt.y + tt.vy * lead;
  const baseAim = Math.atan2(aimY - tk.y, aimX - tk.x);
  const mx0 = tk.x + Math.cos(tk.ta) * 40, my0 = tk.y + Math.sin(tk.ta) * 40;
  const lineBlocked = !sightClear(mx0, my0, aimX, aimY);
  let bankAim = null;
  if (!evading && dist > 150 && dist < 920 && ai.thinkT <= 0) {
    ai.thinkT = 0.12;
    // 玩家贴墙 或 直线视线被挡 → 主动找反弹路径（世界墙 + 障碍边）
    const pNearWall = tt.x < WALL_T + 160 || tt.x > WORLD.w - WALL_T - 160 || tt.y < WALL_T + 160 || tt.y > WORLD.h - WALL_T - 160;
    if (pNearWall || lineBlocked) bankAim = findBankAim(room, tk, tt);
  }
  const aim = bankAim !== null ? bankAim : baseAim;
  let taDiff = aim - tk.ta;
  while (taDiff > Math.PI) taDiff -= 2 * Math.PI;
  while (taDiff < -Math.PI) taDiff += 2 * Math.PI;
  // 弱点位：bot 在玩家侧后方（车头坐标系投影）
  const fwdx = Math.cos(tt.a), fwdy = Math.sin(tt.a);
  const px = fwdx * (tk.x - tt.x) + fwdy * (tk.y - tt.y);
  const py = -fwdx * (tk.y - tt.y) + fwdy * (tk.x - tt.x);
  const behind = px < -18;
  const sidePos = Math.abs(py) > 60;
  const inWeak = behind || sidePos;
  // 开火许可：反弹路径已验过（可直接打）；直线瞄准需视线清晰
  const canSee = bankAim !== null ? true : !lineBlocked;
  const aimOk = Math.abs(taDiff) < (inWeak ? 0.1 : 0.055);
  const shoot = canSee && p.mag > 0 && aimOk && dist < 820 && ai.shootT <= 0;
  if (shoot) ai.shootT = 0.24;

  // ---- 目标点决策（弱点包抄 / 追击 / 拉开）+ A* 导航 ----
  // 侧后方包抄点：玩家后方 130 + 侧向 120（flankDir 交替侧）
  const sideX = -fwdy, sideY = fwdx;
  const flankX = tt.x - fwdx * 130 + sideX * ai.flankDir * 120;
  const flankY = tt.y - fwdy * 130 + sideY * ai.flankDir * 120;
  let goalX, goalY;
  if (evading) {
    // 闪避中：目标 = 闪避方向（不由导航控制，直接走）
    goalX = tk.x + Math.cos(angTo + ai.dodgeDir * Math.PI / 2 + (Math.random() - 0.5) * 0.35) * 200;
    goalY = tk.y + Math.sin(angTo + ai.dodgeDir * Math.PI / 2 + (Math.random() - 0.5) * 0.35) * 200;
  } else if (inWeak && dist > 140 && dist < 560) {
    // 已在侧后：贴住侧后位（持续绕玩家侧后，保持弱点压制角度）
    goalX = tt.x - fwdx * 130 + sideX * ai.flankDir * 120;
    goalY = tt.y - fwdy * 130 + sideY * ai.flankDir * 120;
  } else if (dist > 560) {
    // 远：追击（目标 = 玩家位置偏近点）
    goalX = tt.x - fwdx * 60;
    goalY = tt.y - fwdy * 60;
  } else if (dist < 190) {
    // 过近：拉开
    goalX = tk.x - dx / dist * 260;
    goalY = tk.y - dy / dist * 260;
  } else {
    // 中距离：包抄到侧后方（弱点位）
    goalX = flankX; goalY = flankY;
  }
  // 目标点夹在地图可通行范围内（防 flank 点落在地图外/墙角导致绕大圈）
  goalX = Math.max(WALL_T + 80, Math.min(WORLD.w - WALL_T - 80, goalX));
  goalY = Math.max(WALL_T + 80, Math.min(WORLD.h - WALL_T - 80, goalY));

  // ---- 导航：射线墙跟随（目标射线清晰直冲；被挡沿障碍边缘绕行；鲁棒不依赖网格） ----
  // 卡住检测：持续低前进速度（顶着障碍/墙角振动）0.7s → 倒车转向脱困；两次脱困间隔 ≥1.2s 防误触发循环
  const fwx = Math.cos(tk.a), fwy = Math.sin(tk.a);
  const projSpeed = tk.vx * fwx + tk.vy * fwy; // 前进方向速度投影
  ai.unstickCd = (ai.unstickCd || 0) - dt;
  if (Math.abs(projSpeed) < 4) ai.lowSpeedT = (ai.lowSpeedT || 0) + dt;
  else ai.lowSpeedT = 0;
  if (ai.lowSpeedT > 0.7 && ai.unstickCd <= 0) {
    ai.unstickCd = 1.2;
    ai.unstickT = 0.55;
    // 倒车转向朝目标侧（不随机，脱困后继续接近目标）
    const tg = Math.atan2(goalY - tk.y, goalX - tk.x);
    const relT = angDiff(tg - tk.a);
    ai.unstickDir = relT < 0 ? -1 : 1; // steer=1 右转：目标在左(relT<0)则左转(-1)
    ai.flankDir = -ai.flankDir; // 换包抄方向
    if (ai.rayFollow) ai.followSteer = -ai.followSteer; // 绕行方向不对就换边
    ai.lowSpeedT = 0;
  }

  if (evading) {
    // 闪避：直接朝闪避方向猛冲（不导航）
    const da = angTo + ai.dodgeDir * Math.PI / 2 + (Math.random() - 0.5) * 0.35;
    const dd = angDiff(da);
    p.input = { thr: 1, steer: dd > 0.12 ? 1 : (dd < -0.12 ? -1 : 0), ta: aim, shoot, boost: true };
    return;
  }

  if (bankAim !== null && dist > 150 && dist < 740) {
    // 反弹射击位：反射路径有效 → 站定弹射输出（仅微调距离，不破坏反射几何）
    let thrB;
    if (dist > 520) thrB = 0.6;
    else if (dist < 230) thrB = -0.4;
    else thrB = 0.08;
    const sw = Math.sin(ai.strafeT * 1.4) * 0.12;
    const dd = angDiff(angTo + sw);
    p.input = { thr: thrB, steer: dd > 0.12 ? 1 : (dd < -0.12 ? -1 : 0), ta: aim, shoot, boost: false };
    return;
  }

  if (ai.unstickT > 0) {
    // 脱困：倒车 + 转向
    p.input = { thr: -1, steer: ai.unstickDir, ta: aim, shoot, boost: false };
    return;
  }

  if (ai.forceRoundT > 0) {
    // 强制绕行：持续转向+前进（绕过障碍死角），期间不导航
    ai.forceRoundT -= dt;
    p.input = { thr: 1, steer: ai.forceRoundDir, ta: aim, shoot, boost: false };
    return;
  }

  // ---- 导航：A* 路径（0.4s 无条件重算，A* 确定性保证方向连续）+ wp 跟踪 + 提前转向 ----
  const gAng = Math.atan2(goalY - tk.y, goalX - tk.x);
  ai.pathT = (ai.pathT || 0) - dt;
  if (ai.pathT <= 0) {
    ai.pathT = 0.4;
    ai.path = navFindPath(room, tk.x, tk.y, goalX, goalY, NAV_PAD) || navFindPath(room, tk.x, tk.y, goalX, goalY, NAV_PAD_TIGHT);
    ai.wp = 0;
  }
  let navAng = gAng;
  if (ai.path && ai.path.length > 0) {
    // 跳过已到达的路径点（90px 容差：弧线转弯偏离格点）
    while (ai.wp < ai.path.length && Math.hypot(ai.path[ai.wp].x - tk.x, ai.path[ai.wp].y - tk.y) < 90) ai.wp++;
    if (ai.wp < ai.path.length) {
      navAng = Math.atan2(ai.path[ai.wp].y - tk.y, ai.path[ai.wp].x - tk.x);
      // 提前转向：当前路径点已近（<140）且有下一点 → 朝下一点转（弯道走弧线）
      if (ai.wp + 1 < ai.path.length) {
        const dCur = Math.hypot(ai.path[ai.wp].x - tk.x, ai.path[ai.wp].y - tk.y);
        if (dCur < 140) navAng = Math.atan2(ai.path[ai.wp + 1].y - tk.y, ai.path[ai.wp + 1].x - tk.x);
      }
    }
  }
  const ndiff = angDiff(navAng);
  // 距离目标远 → 全速；近 → 减速（避免过冲）
  const gd = Math.hypot(goalX - tk.x, goalY - tk.y);
  let thr = gd > 90 ? 1 : (gd > 45 ? 0.6 : 0.35);
  // 连续减速转弯：转向角越大油门越低（转弯半径随速度下降；大角度近原地转，防 90° 弯卡角）
  thr = Math.max(0.08, thr * (1 - Math.min(1, Math.abs(ndiff) / 1.3) * 0.85));
  // 中距离包抄完成（侧后位）→ 摆角压制不硬顶
  if (inWeak && dist > 150 && dist < 480 && gd < 150) {
    thr = dist > 250 ? 0.6 : (dist < 195 ? -0.45 : 0.25);
    // 保持侧后：目标方向加摆动（身法）
    const sw = Math.sin(ai.strafeT * 2.3) * 0.3;
    const da = angTo + sw;
    const dd = angDiff(da);
    p.input = { thr, steer: dd > 0.12 ? 1 : (dd < -0.12 ? -1 : 0), ta: aim, shoot, boost: false };
    return;
  }
  // 追击时蛇形摆角（减少直线被命中）
  if (dist > 400 && gd > 150) {
    const sw = Math.sin(ai.strafeT * 1.7) * 0.24;
    const da = navAng + sw;
    const dd = angDiff(da);
    p.input = { thr: 1, steer: dd > 0.12 ? 1 : (dd < -0.12 ? -1 : 0), ta: aim, shoot, boost: false };
    return;
  }
  const steer = ndiff > 0.12 ? 1 : (ndiff < -0.12 ? -1 : 0);
  if (process.env.TK_AI_DEBUG === '1' && room.tick % 30 === 0) {
    console.log('[AI] tick=' + room.tick + ' pos=' + Math.round(tk.x) + ',' + Math.round(tk.y) +
      ' mode=' + ai.mode + ' goal=' + Math.round(goalX) + ',' + Math.round(goalY) +
      ' follow=' + (ai.rayFollow ? (ai.followSteer > 0 ? 'R' : 'L') : '-') +
      ' navAng=' + (navAng !== null ? Math.round(navAng * 57.3) : '-') +
      ' inWeak=' + inWeak + ' dist=' + Math.round(dist) + ' gd=' + Math.round(gd) +
      ' projV=' + Math.round(projSpeed) + ' lowT=' + Math.round((ai.lowSpeedT || 0) * 100) +
      ' unstickCd=' + Math.round((ai.unstickCd || 0) * 100) + ' evad=' + evading);
  }
  p.input = { thr, steer, ta: aim, shoot, boost: false };
}

function removePlayer(room, p) {
  room.players.delete(p.id);
  if (p.conn) p.conn.player = null;
  if (room.hostId === p.id) {
    const first = [...room.players.values()].find((q) => !q.isBot) || [...room.players.values()][0];
    room.hostId = first ? first.id : null;
  }
  room.pendingEvents.push({ k: 'leave', name: p.name });
  // 无真人玩家时关闭房间（单人模式玩家离开即结束）
  const hasHuman = [...room.players.values()].some((q) => !q.isBot);
  if (!hasHuman) { rooms.delete(room.code); return; }
  broadcastRoom(room);
  broadcast(room);
}

function spawnPlayer(room, p, seat) {
  const s = seat || SPAWNS[rnd(SPAWNS.length)];
  p.tank = { x: s.x, y: s.y, a: s.a, ta: s.a, vx: 0, vy: 0, hp: TANK.hp };
  p.alive = true;
  p.deadAt = 0;
  p.fireCd = 0;
  p.shield = false;
  p.rapid = 0;
  p.triple = 0;
  p.mag = MAG_SIZE;                       // 单发：开局已装填
  p.reloadT = 0;
  p.parts = { track: true, turret: true, engine: true, ammo: true, optics: true, loader: true };
  p.repairT = 0;
  p.eraHit = false; // 本回合是否已被命中（爆反首击大扣减判定）
  p.fireT = 0;
  p.fireDmg = 0;
  p.era = initialEra(p.type);         // 反应装甲按型号重置
}

function startRound(room) {
  room.roundNo++;
  // 每回合生成全新迷宫，并重新计算出生点（移到最近通道）
  room.obstacles = roomMap();
  const usedCells = new Set();
  room.spawns = SPAWNS.map((s) => {
    const f = fitSpawn(room.obstacles, s.x, s.y, 24, WORLD.w, WORLD.h, WALL_T, usedCells);
    return { x: f.x, y: f.y, a: s.a };
  });
  // 广播新地图
  const mapMsg = { t: 'map', obstacles: room.obstacles };
  for (const p of room.players.values()) send(p.conn, mapMsg);
  room.bullets = [];
  room.pups = [];
  room.pupTimer = 3;
  room.winner = null;
  const solo = room.players.size <= 1;
  room.phase = solo ? 'play' : 'countdown';
  room.phaseT = solo ? 0 : 3;
  let i = 0;
  for (const p of room.players.values()) { spawnPlayer(room, p, room.spawns[i % room.spawns.length]); i++; }
  room.pendingEvents.push({ k: 'round', n: room.roundNo });
  if (!solo) room.pendingEvents.push({ k: 'tick', n: 3 });
  broadcastRoom(room);
}

// render-restart-2026 placeholder
// ---------------- 物理与战斗 ----------------
function collideTankWorld(tk, obstacles) {
  // 世界墙：固定外接半轴（不随朝向突变，稳定）
  const wR = Math.hypot(TANK.rx, TANK.ry); // 外接半径 46
  const minX = WALL_T + wR, maxX = WORLD.w - WALL_T - wR;
  const minY = WALL_T + wR, maxY = WORLD.h - WALL_T - wR;
  if (tk.x < minX) { tk.x = minX; if (tk.vx < 0) tk.vx = -tk.vx * 0.3; }
  else if (tk.x > maxX) { tk.x = maxX; if (tk.vx > 0) tk.vx = -tk.vx * 0.3; }
  if (tk.y < minY) { tk.y = minY; if (tk.vy < 0) tk.vy = -tk.vy * 0.3; }
  else if (tk.y > maxY) { tk.y = maxY; if (tk.vy > 0) tk.vy = -tk.vy * 0.3; }
  // 障碍：旋转矩形（OBB）vs AABB，SAT 分离轴精确碰撞（稳定，不随朝向突变）
  const ca = Math.cos(tk.a), sa = Math.sin(tk.a);
  const tc = [ // 坦克矩形 4 角（世界）
    [tk.x + ca * TANK.rx - sa * TANK.ry, tk.y + sa * TANK.rx + ca * TANK.ry],
    [tk.x + ca * TANK.rx + sa * TANK.ry, tk.y + sa * TANK.rx - ca * TANK.ry],
    [tk.x - ca * TANK.rx + sa * TANK.ry, tk.y - sa * TANK.rx - ca * TANK.ry],
    [tk.x - ca * TANK.rx - sa * TANK.ry, tk.y - sa * TANK.rx + ca * TANK.ry],
  ];
  for (const o of obstacles) {
    const corners = [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]];
    const axes = [[ca, sa], [-sa, ca], [1, 0], [0, 1]];
    let minOverlap = Infinity, ax = 0, ay = 0;
    let separated = false;
    for (const [ax2, ay2] of axes) {
      let tMin = Infinity, tMax = -Infinity;
      for (const [px, py] of tc) { const v = px * ax2 + py * ay2; if (v < tMin) tMin = v; if (v > tMax) tMax = v; }
      let oMin = Infinity, oMax = -Infinity;
      for (const [px, py] of corners) { const v = px * ax2 + py * ay2; if (v < oMin) oMin = v; if (v > oMax) oMax = v; }
      const overlap = Math.min(tMax, oMax) - Math.max(tMin, oMin);
      if (overlap <= 0) { separated = true; break; }
      if (overlap < minOverlap) { minOverlap = overlap; ax = ax2; ay = ay2; }
    }
    if (!separated && minOverlap > 0) {
      // 法线指向远离障碍中心（把坦克推出障碍）
      const cx = tk.x - (o.x + o.w / 2), cy = tk.y - (o.y + o.h / 2);
      if (ax * cx + ay * cy < 0) { ax = -ax; ay = -ay; }
      tk.x += ax * minOverlap;
      tk.y += ay * minOverlap;
      const vn = tk.vx * ax + tk.vy * ay;
      if (vn < 0) { tk.vx -= ax * vn * 1.7; tk.vy -= ay * vn * 1.7; }
    }
  }
}

function sim(room, dt, now) {
  const list = [...room.players.values()];
  const alive = [];
  for (const p of list) if (p.alive && p.tank) alive.push(p);

  // ---- 坦克移动 / 开火 ----
  for (const p of alive) {
    const tk = p.tank;
    if (p.isBot) botThink(p, room, dt); // AI 玩家：每 tick 生成行为输入（智能战斗 AI）
    const inp = p.input;
    p.fireCd -= dt;
    const rapid = p.rapid > 0; p.rapid -= dt;
    const triple = p.triple > 0; p.triple -= dt;
    // 换弹计时：装填完成后恢复弹匣（单发制）
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) p.mag = MAG_SIZE;
    }
    // 着火：持续掉血
    if (p.fireT > 0) {
      p.fireT -= dt;
      if (p.fireT <= 0) p.ammoFire = false; // 弹药架起火标记随火势结束清除
      p.fireDmg += dt * FIRE_DPS;
      while (p.fireDmg >= 1) {
        p.fireDmg -= 1;
        tk.hp -= 1;
        if (tk.hp <= 0 && p.alive) {
          p.alive = false;
          p.deadAt = now;
          const killer = room.players.get(p.lastHitBy);
          if (killer && killer.id !== p.id) {
            killer.kills++;
            room.pendingEvents.push({ k: 'kill', killer: killer.name, victim: p.name, reason: '烧毁', x: Math.round(tk.x), y: Math.round(tk.y) });
          }
          room.pendingEvents.push({ k: 'boom', x: Math.round(tk.x), y: Math.round(tk.y) });
        }
      }
    }
    // 模块化损伤：部件效果
    const canMove = p.parts.track;
    const canFire = p.parts.turret;
    // 维修：完全静止（无油门/转向/开火）且部件损坏时累积进度，2.5 秒修好一个
    const brokenCount = PARTS_LIST.filter((n) => !p.parts[n]).length;
    if (brokenCount > 0 && inp.thr === 0 && inp.steer === 0 && !inp.shoot) {
      p.repairT += dt;
      if (p.repairT >= REPAIR_TIME) {
        p.repairT = 0;
        const broken = PARTS_LIST.filter((n) => !p.parts[n]);
        const pick = broken[rnd(broken.length)];
        p.parts[pick] = true;
        room.pendingEvents.push({ k: 'repair', id: p.id, part: pick, x: Math.round(tk.x), y: Math.round(tk.y) });
      }
    } else {
      p.repairT = 0;
    }

    const f = { x: Math.cos(tk.a), y: Math.sin(tk.a) };
    const px = -f.y, py = f.x;
    const tt = TANK_TYPES[p.type];
    const thr = (canMove ? inp.thr : 0) * (inp.thr < 0 ? tt.back : 1);
    tk.vx += f.x * thr * TANK.accel * dt;
    tk.vy += f.y * thr * TANK.accel * dt;
    let fwd = tk.vx * f.x + tk.vy * f.y;
    let lat = tk.vx * px + tk.vy * py;
    const dragF = inp.thr !== 0 ? TANK.dragF : 1.7;
    fwd *= Math.exp(-dragF * dt);
    lat *= Math.exp(-TANK.dragL * dt);
    tk.vx = f.x * fwd + px * lat;
    tk.vy = f.y * fwd + py * lat;
    const spd = tt.maxSpeed * (p.parts.engine ? 1 : 0.45) * (inp.boost ? TANK.boostMult : 1);
    const sp = Math.hypot(tk.vx, tk.vy);
    if (sp > spd) { tk.vx *= spd / sp; tk.vy *= spd / sp; }

    tk.x += tk.vx * dt;
    tk.y += tk.vy * dt;
    tk.a += inp.steer * TANK.turn * dt;
    if (inp.ta != null) tk.ta = inp.ta;

    collideTankWorld(tk, room.obstacles);

    // 开火（单发制：装填完成后可发射；炮塔损坏无法开火；弹药架损坏开火有殉爆风险；枪口顶墙禁止隔墙射击）
    if (inp.shoot && p.fireCd <= 0 && p.mag > 0 && canFire) {
      const mx = tk.x + Math.cos(tk.ta) * 34;
      const my = tk.y + Math.sin(tk.ta) * 34;
      // 炮管穿过障碍（隔墙射击）修复：枪口在障碍内则无法开火
      let muzzleBlocked = false;
      for (const o of room.obstacles) {
        if (mx >= o.x && mx <= o.x + o.w && my >= o.y && my <= o.y + o.h) { muzzleBlocked = true; break; }
      }
      if (!muzzleBlocked) {
        // 弹药架受损：25% 概率开火殉爆
        if (!p.parts.ammo && Math.random() < 0.25) {
          p.alive = false;
          p.deadAt = now;
          const killer = room.players.get(p.lastHitBy);
          if (killer && killer.id !== p.id) {
            killer.kills++;
            room.pendingEvents.push({ k: 'kill', killer: killer.name, victim: p.name, reason: '殉爆', x: Math.round(tk.x), y: Math.round(tk.y) });
          }
          room.pendingEvents.push({ k: 'boom', x: Math.round(tk.x), y: Math.round(tk.y) });
          continue; // 下一辆坦克
        }
        p.fireCd = 0;
        p.mag = 0;
        // 装填时间：按型号，装弹机损坏翻倍，速射道具减半
        let reload = tt.reload;
        if (tt.hasLoader && p.parts.loader === false) reload *= 2; // 俄军装弹机损坏；美军无装弹机
        if (rapid) reload *= 0.5;
        p.reloadT = reload;
        const fire = (ang) => {
          room.bullets.push({
            x: mx, y: my,
            vx: Math.cos(ang) * BULLET.speed, vy: Math.sin(ang) * BULLET.speed,
            ownerId: p.id, ownerType: p.type, pen: tt.pen, life: BULLET.life,
            spawnT: now, // 出生保护：刚出膛 200ms 内不判定命中自己（防斜射时炮口投影落入命中框吞炮弹）
            penBounces: 0, // 反弹计数（90式反弹增益用）
          });
        };
        if (triple) { fire(tk.ta - 0.18); fire(tk.ta); fire(tk.ta + 0.18); }
        else fire(tk.ta);
        room.pendingEvents.push({ k: 'shot', id: p.id, x: Math.round(mx), y: Math.round(my) });
      }
    }
  }

  // ---- 坦克互撞（椭圆近似：在 A 的缩放空间内按单位圆处理） ----
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i].tank, b = alive[j].tank;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dxs = dx / TANK.rx, dys = dy / TANK.ry; // A 缩放空间
      const ds = Math.hypot(dxs, dys);
      const minS = 2;
      if (ds > 0.001 && ds < minS) {
        const nxs = dxs / ds, nys = dys / ds;
        const push = (minS - ds) / 2;
        a.x -= nxs * push * TANK.rx; a.y -= nys * push * TANK.ry;
        b.x += nxs * push * TANK.rx; b.y += nys * push * TANK.ry;
        const dxw = b.x - a.x, dyw = b.y - a.y;
        const dw = Math.hypot(dxw, dyw) || 0.001;
        const nx = dxw / dw, ny = dyw / dw;
        const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const imp = -vn * 0.5;
          a.vx -= nx * imp; a.vy -= ny * imp;
          b.vx += nx * imp; b.vy += ny * imp;
        }
      }
    }
  }

  // ---- 子弹 ----
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    const px = b.x, py = b.y;   // 上一帧位置（线段碰撞防隧穿）
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    let dead = b.life <= 0;

    // 反弹穿深处理（普通扣穿深；90式反弹+100穿深，最多 9 次）
    const bDead = () => applyBouncePen(b, room);

    // 边界反弹
    if (!dead && b.x < WALL_T + BULLET.r) { b.x = WALL_T + BULLET.r; b.vx = -b.vx; if (bDead()) dead = true; }
    if (!dead && b.x > WORLD.w - WALL_T - BULLET.r) { b.x = WORLD.w - WALL_T - BULLET.r; b.vx = -b.vx; if (bDead()) dead = true; }
    if (!dead && b.y < WALL_T + BULLET.r) { b.y = WALL_T + BULLET.r; b.vy = -b.vy; if (bDead()) dead = true; }
    if (!dead && b.y > WORLD.h - WALL_T - BULLET.r) { b.y = WORLD.h - WALL_T - BULLET.r; b.vy = -b.vy; if (bDead()) dead = true; }

    // 障碍碰撞：线段检测（防高速隧穿穿墙），仅在真正撞击表面时反弹并消耗穿深
    if (!dead) {
      for (const o of room.obstacles) {
        const hit = segRectHit(px, py, b.x, b.y, o);
        if (hit) {
          b.x = hit.x; b.y = hit.y;
          const vn = b.vx * hit.nx + b.vy * hit.ny;
          if (vn < 0) {
            b.vx -= 2 * vn * hit.nx;
            b.vy -= 2 * vn * hit.ny;
            if (bDead()) dead = true;
          }
          break;
        }
      }
    }
    // 兜底：子弹中心进入障碍内部（擦角/极端情况）→ 强制按最近表面推出并反弹，杜绝穿墙
    if (!dead) {
      for (const o of room.obstacles) {
        if (b.x > o.x && b.x < o.x + o.w && b.y > o.y && b.y < o.y + o.h) {
          const dl = b.x - o.x, dr = o.x + o.w - b.x;
          const dt = b.y - o.y, db = o.y + o.h - b.y;
          const min = Math.min(dl, dr, dt, db);
          let nx = 0, ny = 0;
          if (min === dl) { b.x = o.x - BULLET.r; nx = -1; }
          else if (min === dr) { b.x = o.x + o.w + BULLET.r; nx = 1; }
          else if (min === dt) { b.y = o.y - BULLET.r; ny = -1; }
          else { b.y = o.y + o.h + BULLET.r; ny = 1; }
          const vn = b.vx * nx + b.vy * ny;
          if (vn < 0) {
            b.vx -= 2 * vn * nx; b.vy -= 2 * vn * ny;
            if (bDead()) dead = true;
          }
          break;
        }
      }
    }

    // 命中坦克（模块化损伤：旋转矩形碰撞与贴图轮廓吻合 / 弹药架弱点区域 / 装甲厚度×炮弹穿深判定 / 爆反血条）
    if (!dead) {
      for (const q of alive) {
        // 允许命中自己：反弹回来的炮弹同样造成伤害（炮口 34 > 命中框半长 31，正对开火不会立即自伤）
        // 出生保护：出膛 200ms 内不判定命中发射者自己（斜射时炮口投影会落入命中框，否则斜射吞炮弹+自伤）
        if (q.id === b.ownerId && now - (b.spawnT || 0) < 0.2) continue;
        const t2 = q.tank;
        // 命中点局部坐标：+x = 坦克车头方向（子弹相对坦克，符号与车头朝向一致）
        const dx = b.x - t2.x, dy = b.y - t2.y;
        const fwdX = Math.cos(t2.a), fwdY = Math.sin(t2.a);
        const rx = dx * fwdX + dy * fwdY;
        const ry = -dx * fwdY + dy * fwdX;
        if (Math.abs(rx) < TANK.l / 2 + BULLET.r && Math.abs(ry) < TANK.w / 2 + BULLET.r) {
          dead = true;
          if (q.shield) {
            q.shield = false;
            room.pendingEvents.push({ k: 'shield', id: q.id, x: Math.round(t2.x), y: Math.round(t2.y) });
          } else {
            const tt = TANK_TYPES[q.type];
            // 部位判定：命中点在车体的前后/侧面位置（与贴图视觉一致）
            const zone = rx > TANK.l * 0.12 ? 'front' : (rx < -TANK.l * 0.12 ? 'back' : 'side');
            const dmg = zone === 'front' ? 20 : (zone === 'back' ? 40 : 30); // 部位基础伤害
            const eraBefore = q.era; // 命中前爆反血量（俄军侧面殉爆屏蔽按命中前判定）
            // 弹药架弱点区域（按型号设计，贴图对应位置）：击中必殉爆
            // 美军：炮塔尾舱（车体后部偏窄区域，精细判定）；俄军：侧面中心
            // 俄军爆反不低于 30% 时，侧面命中（含弹药架区域）不触发殉爆
            const ruSideSafe = q.type === 'ru' && eraBefore >= tt.era * 0.3;
            const ammoHit = tt.ammoZone === 'rear'
              ? (rx < -13 && Math.abs(ry) < 13)   // 美军：炮塔尾舱（车体后部中央偏窄）
              : (Math.abs(ry) > 17 && Math.abs(rx) < 16 && !ruSideSafe); // 俄军：侧面中心（爆反≥30%不殉爆）
            if (ammoHit) {
              // 弹药架殉爆：先起火再殉爆（起火视觉效果），立即击毁（弱点命中无视反应装甲）
              q.fireT = FIRE_TIME;
              q.fireDmg = 0;
              room.pendingEvents.push({ k: 'fire', id: q.id, x: Math.round(t2.x), y: Math.round(t2.y) });
              q.alive = false;
              q.deadAt = now;
              const killer = room.players.get(b.ownerId);
              if (killer && killer.id !== q.id) {
                killer.kills++;
                room.pendingEvents.push({ k: 'kill', killer: killer.name, victim: q.name, reason: '殉爆', x: Math.round(t2.x), y: Math.round(t2.y) });
              }
              room.pendingEvents.push({ k: 'boom', x: Math.round(t2.x), y: Math.round(t2.y) });
            } else {
              // 爆反血条：本回合首次被命中扣 40-70 随机，之后每次扣 20-40 随机
              const eraFirstHit = !q.eraHit; // 本回合是否首次被命中
              q.eraHit = true;
              const eraCost = eraFirstHit ? (40 + Math.floor(Math.random() * 31)) : (20 + Math.floor(Math.random() * 21));
              if (q.era > 0) q.era = Math.max(0, q.era - eraCost);
              // 装甲厚度判定：爆反生效时正面/侧面增强（背面不变）
              const armor = (q.era > 0 ? tt.armorEra : tt.armor)[zone];
              const ratio = b.pen / armor;
              const brokenParts = [];
              const breakOne = (pool) => {
                const avail = pool.filter((n) => q.parts[n]);
                if (!avail.length) return;
                const pick = avail[rnd(avail.length)];
                q.parts[pick] = false;
                brokenParts.push(pick);
              };
              if (ratio >= 1.0) {
                // 完全击穿：全伤害 + 随机其他部位模块 + 起火/殉爆概率
                t2.hp -= dmg;
                q.lastHitBy = b.ownerId;
                // 随机损坏一个模块（美军无装弹机，排除 loader；模块损坏只在击穿时发生，跳弹一律不坏）
                let avail = PARTS_LIST.filter((n) => q.parts[n] && (q.type === 'ru' || n !== 'loader'));
                // 90式机制：前置弹药架——爆反不满血时正面击穿 50% 弹药架起火（有爆反满血时不会被击穿起火）
                if (q.type === 'jp' && zone === 'front' && q.era < tt.era && Math.random() < 0.5) {
                  q.fireT = FIRE_TIME;
                  q.fireDmg = 0;
                  q.ammoFire = true; // 弹药架起火标记（客户端剧烈特效）
                  room.pendingEvents.push({ k: 'fire', id: q.id, x: Math.round(t2.x), y: Math.round(t2.y), am: true });
                } else if (q.type === 'us' && zone === 'front' && q.era < tt.era && q.parts.turret && Math.random() < 0.3) {
                  q.parts.turret = false;
                  brokenParts.push('turret');
                } else if (q.type === 'us' && zone === 'side' && q.parts.turret && Math.random() < 0.4) {
                  // 美军侧面击穿：40% 优先坏炮塔（侧面不再只坏无关紧要的模块）
                  q.parts.turret = false;
                  brokenParts.push('turret');
                } else if (avail.length) {
                  const pick = avail[rnd(avail.length)];
                  q.parts[pick] = false;
                  brokenParts.push(pick);
                }
                // 观瞄随机附加损坏
                if (q.parts.optics && Math.random() < 0.15) { q.parts.optics = false; brokenParts.push('optics'); }
                // 起火：反应装甲存在时概率较低，失效后正常
                const fireChance = q.era > 0 ? 0.06 : 0.12;
                if (Math.random() < fireChance) {
                  q.fireT = FIRE_TIME;
                  q.fireDmg = 0;
                  room.pendingEvents.push({ k: 'fire', id: q.id, x: Math.round(t2.x), y: Math.round(t2.y) });
                }
                // 殉爆（非弱点区域）：俄军爆反≥30%时侧面不殉爆；其余按爆反状态与部位
                let detChance = zone === 'side' ? (q.era > 0 ? 0.03 : 0.15) : (zone === 'back' ? (q.era > 0 ? 0.1 : 0.4) : 0);
                if (q.type === 'ru' && zone === 'side' && eraBefore >= tt.era * 0.3) detChance = 0; // 俄军爆反保护
                if (zone !== 'front' && Math.random() < detChance) {
                  q.alive = false;
                  q.deadAt = now;
                  const killer = room.players.get(b.ownerId);
                  if (killer && killer.id !== q.id) {
                    killer.kills++;
                    room.pendingEvents.push({ k: 'kill', killer: killer.name, victim: q.name, reason: '殉爆', x: Math.round(t2.x), y: Math.round(t2.y) });
                  }
                  room.pendingEvents.push({ k: 'boom', x: Math.round(t2.x), y: Math.round(t2.y) });
                } else {
                  room.pendingEvents.push({ k: 'hit', id: q.id, zone, parts: brokenParts, pen: true, era: q.era, x: Math.round(b.x), y: Math.round(b.y) });
                  if (t2.hp <= 0) {
                    q.alive = false;
                    q.deadAt = now;
                    const killer = room.players.get(b.ownerId);
                    if (killer && killer.id !== q.id) {
                      killer.kills++;
                      room.pendingEvents.push({ k: 'kill', killer: killer.name, victim: q.name, reason: q.era > 0 ? '击毁' : '车组阵亡', x: Math.round(t2.x), y: Math.round(t2.y) });
                    }
                    room.pendingEvents.push({ k: 'boom', x: Math.round(t2.x), y: Math.round(t2.y) });
                  }
                }
              } else if (ratio >= 0.9) {
                // 未击穿但穿透压力极大：损坏命中部位对应模块，不致死
                if (zone === 'front') {
                  if (q.type === 'ru') {
                    // 俄军正面：只可能坏履带或装弹机
                    breakOne(['track', 'loader']);
                  } else {
                    // 美军正面：未击穿只坏履带（炮塔损坏只在击穿时判定，未击穿不坏炮塔）
                    breakOne(['track']);
                  }
                } else if (zone === 'back') {
                  // 背面：起火 或 发动机损坏（通用）
                  if (Math.random() < 0.5) {
                    q.fireT = FIRE_TIME;
                    q.fireDmg = 0;
                    room.pendingEvents.push({ k: 'fire', id: q.id, x: Math.round(t2.x), y: Math.round(t2.y) });
                  } else {
                    breakOne(['engine']);
                  }
                } else {
                  // 侧面：美军 track/turret 随机（履带已坏时仍能坏炮塔，提高"坏东西"概率）
                  if (q.type === 'us') {
                    if (Math.random() < 0.5) breakOne(['track']);
                    else breakOne(['turret']);
                  } else {
                    breakOne(['track']);
                  }
                }
                room.pendingEvents.push({ k: 'hit', id: q.id, zone, parts: brokenParts, pen: false, era: q.era, x: Math.round(b.x), y: Math.round(b.y) });
              } else {
                // 未击穿（跳弹）：仅消耗爆反，无伤害无模块
                room.pendingEvents.push({ k: 'hit', id: q.id, zone, parts: [], pen: false, era: q.era, x: Math.round(b.x), y: Math.round(b.y) });
              }
            }
          }
          break;
        }
      }
    }

    // 子弹互撞（不同所有者）
    if (!dead) {
      for (let j = i - 1; j >= 0; j--) {
        const c = room.bullets[j];
        if (c.ownerId === b.ownerId) continue;
        const dx = c.x - b.x, dy = c.y - b.y;
        const rr = BULLET.r * 2;
        if (dx * dx + dy * dy < rr * rr) { dead = true; room.bullets.splice(j, 1); break; }
      }
    }

    if (dead) room.bullets.splice(i, 1);
  }

  // ---- 道具 ----
  room.pupTimer -= dt;
  if (room.pupTimer <= 0 && room.pups.length < POWERUP.max) {
    room.pupTimer = POWERUP.spawnEvery;
    const type = ['health', 'shield', 'rapid', 'triple'][weightedPick([0.34, 0.24, 0.21, 0.21])];
    for (let tries = 0; tries < 40; tries++) {
      const x = WALL_T + 70 + Math.random() * (WORLD.w - 2 * (WALL_T + 70));
      const y = WALL_T + 70 + Math.random() * (WORLD.h - 2 * (WALL_T + 70));
      if (insideObstacle(x, y, POWERUP.r + 6, room.obstacles)) continue;
      room.pups.push({ x, y, type, life: POWERUP.life });
      break;
    }
  }
  for (let i = room.pups.length - 1; i >= 0; i--) {
    const pu = room.pups[i];
    pu.life -= dt;
    let taken = false;
    for (const p of alive) {
      const tk = p.tank;
      const dx = tk.x - pu.x, dy = tk.y - pu.y;
      const rr = (TANK.rx + TANK.ry) / 2 + POWERUP.r;
      if (dx * dx + dy * dy < rr * rr) {
        taken = true;
        if (pu.type === 'health') {
          tk.hp = Math.min(TANK.hp, tk.hp + 50);
          for (const n of PARTS_LIST) p.parts[n] = true; // 血包同时修复所有部件
        }
        else if (pu.type === 'shield') p.shield = true;
        else if (pu.type === 'rapid') p.rapid = 8;
        else if (pu.type === 'triple') p.triple = 8;
        room.pendingEvents.push({ k: 'pick', type: pu.type, x: Math.round(tk.x), y: Math.round(tk.y) });
        break;
      }
    }
    if (taken || pu.life <= 0) room.pups.splice(i, 1);
  }

  // ---- 单人自由模式：死亡后重生 ----
  if (room.players.size === 1) {
    const p = [...room.players.values()][0];
    if (!p.alive && now - p.deadAt > 2500) spawnPlayer(room, p);
  }

  // ---- 回合结束判定（多人时最后一辆坦克获胜） ----
  if (room.players.size > 1) {
    let lastAlive = null;
    let count = 0;
    for (const p of room.players.values()) if (p.alive) { count++; lastAlive = p; }
    if (count <= 1) {
      room.phase = 'over';
      room.phaseT = 3.5;
      room.winner = lastAlive ? lastAlive.id : null;
      if (lastAlive) lastAlive.wins++;
      room.pendingEvents.push({ k: 'win', name: lastAlive ? lastAlive.name : null });
      room.bullets = [];
    }
  }
}

// ---------------- 消息发送 ----------------
function send(conn, obj) {
  if (!conn || conn.dead) return;
  try { conn.socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(obj)), false)); } catch (e) { /* ignore */ }
}

// ---------------- 公网通道（cloudflared quick tunnel，一键生成公网链接） ----------------
let actualPort = WANTED_PORT;
const tunnel = { state: 'off', url: null, proc: null };
let tunnelError = '';

function broadcastTunnel(msg) {
  const m = { t: 'tunnel' };
  for (const k of Object.keys(msg)) m[k] = msg[k];
  for (const room of rooms.values()) {
    for (const p of room.players.values()) send(p.conn, m);
  }
}

function findCloudflared() {
  if (process.env.CLOUDFLARED && fs.existsSync(process.env.CLOUDFLARED)) return process.env.CLOUDFLARED;
  const bin = path.join(__dirname, 'bin', 'cloudflared.exe');
  if (fs.existsSync(bin)) return bin;
  return null;
}

async function ensureCloudflared() {
  const local = findCloudflared();
  if (local) return local;
  // PATH 中查找
  try {
    await new Promise((resolve, reject) => {
      execFile('cloudflared', ['--version'], { timeout: 8000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
    return 'cloudflared';
  } catch (e) { /* 不在 PATH 中，继续下载 */ }
  return downloadCloudflared(path.join(__dirname, 'bin', 'cloudflared.exe'));
}

async function startTunnel() {
  if (tunnel.state === 'starting' || tunnel.state === 'on') return;
  if (process.env.TK_TUNNEL_DISABLED) {
    broadcastTunnel({ state: 'error', error: '此环境未启用公网联机' });
    return;
  }
  // 云端/服务器部署(Linux等)本身就有公网地址，无需再开隧道
  if (process.platform !== 'win32') {
    broadcastTunnel({ state: 'error', error: '云端/服务器部署无需公网通道：当前网址即为公网地址，直接把网址发给好友即可。' });
    return;
  }
  tunnel.state = 'starting';
  tunnelError = '';
  broadcastTunnel({ state: 'starting' });
  try {
    const bin = await ensureCloudflared();
    const proc = spawn(bin, ['tunnel', '--url', 'http://127.0.0.1:' + actualPort, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    tunnel.proc = proc;
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        tunnel.url = m[0];
        tunnel.state = 'on';
        broadcastTunnel({ state: 'on', url: tunnel.url });
        console.log('公网通道已建立: ' + tunnel.url);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      tunnel.proc = null;
      tunnel.state = 'off';
      tunnelError = err.message;
      broadcastTunnel({ state: 'error', error: err.message });
    });
    proc.on('exit', (code) => {
      tunnel.proc = null;
      if (tunnel.state === 'on') {
        tunnel.state = 'off';
        tunnel.url = null;
        broadcastTunnel({ state: 'off' });
      } else if (tunnel.state === 'starting') {
        tunnel.state = 'off';
        tunnelError = '通道进程退出(码 ' + code + ')';
        broadcastTunnel({ state: 'error', error: tunnelError });
      }
    });
  } catch (e) {
    tunnel.state = 'off';
    tunnelError = e.message;
    broadcastTunnel({ state: 'error', error: e.message });
  }
}

function stopTunnel() {
  if (tunnel.proc) { try { tunnel.proc.kill(); } catch (e) { /* ignore */ } tunnel.proc = null; }
  tunnel.state = 'off';
  tunnel.url = null;
  broadcastTunnel({ state: 'off' });
}

function broadcastRoom(room) {
  const msg = {
    t: 'room',
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    publicUrl: tunnel.state === 'on' ? tunnel.url : null,
    players: roster(room),
  };
  for (const p of room.players.values()) send(p.conn, msg);
}

function broadcast(room) {
  const players = [...room.players.values()].map((p) => {
    const t = p.tank;
    return {
      id: p.id, name: p.name,
      x: t ? Math.round(t.x) : null,
      y: t ? Math.round(t.y) : null,
      a: t ? Math.round(t.a * 100) / 100 : 0,
      ta: t ? Math.round(t.ta * 100) / 100 : 0,
      hp: t ? Math.max(0, Math.round(t.hp)) : 0,
      alive: p.alive,
      shd: p.shield ? 1 : 0,
      rap: p.rapid > 0 ? Math.ceil(p.rapid) : 0,
      trp: p.triple > 0 ? Math.ceil(p.triple) : 0,
      mag: p.mag,
      rl: Math.round(p.reloadT * 10) / 10,
      ty: p.type,
      era: p.era,
      prt: [p.parts.track, p.parts.turret, p.parts.engine, p.parts.ammo, p.parts.optics, p.parts.loader],
      rp: Math.round(p.repairT * 10) / 10,
      fr: p.fireT > 0 ? Math.ceil(p.fireT) : 0,
      am: p.ammoFire ? 1 : 0, // 弹药架起火标记（客户端剧烈火焰特效）
      kills: p.kills, wins: p.wins,
    };
  });
  const msg = {
    t: 'snap',
    seq: room.tick,
    phase: room.phase,
    phaseT: Math.round(room.phaseT * 10) / 10,
    winner: room.winner,
    players,
    bullets: room.bullets.map((b) => ({
      x: Math.round(b.x), y: Math.round(b.y),
      vx: Math.round(b.vx), vy: Math.round(b.vy),
      o: b.ownerId,
      pen: Math.round(b.pen),
    })),
    pups: room.pups.map((pu) => ({ x: Math.round(pu.x), y: Math.round(pu.y), type: pu.type, life: Math.round(pu.life) })),
    events: room.pendingEvents.splice(0),
  };
  for (const p of room.players.values()) send(p.conn, msg);
}

// ---------------- 客户端消息 ----------------
function onMessage(conn, buf) {
  let msg;
  try { msg = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
  if (!msg || typeof msg !== 'object') return;
  const p = conn.player;
  switch (msg.t) {
    case 'join': {
      if (p) return;
      const name = sanitizeName(msg.name);
      const wantRoom = msg.room ? String(msg.room).toUpperCase().trim() : '';
      const room = wantRoom ? rooms.get(wantRoom) : null;
      if (wantRoom && !room) { send(conn, { t: 'err', msg: '房间不存在或已关闭' }); conn.die(); return; }
      if (room && room.players.size >= MAX_PLAYERS) { send(conn, { t: 'err', msg: '房间已满（最多 ' + MAX_PLAYERS + ' 人）' }); conn.die(); return; }
      // 断线恢复：用原玩家 id 匹配，恢复断线玩家的坦克与状态（不重新入座、不变旁观）
      if (room && msg.resume) {
        const old = room.players.get(String(msg.resume));
        if (old && old.disconnected) {
          clearTimeout(old.removeTimer);
          old.disconnected = false;
          old.conn = conn;
          old.input = { thr: 0, steer: 0, ta: old.input.ta, shoot: false, boost: false };
          conn.player = old;
          send(conn, {
            t: 'hello', id: old.id, name: old.name, code: room.code, hostId: room.hostId,
            phase: room.phase, phaseT: Math.round(room.phaseT * 10) / 10, winner: room.winner,
            lan: lanHint(),
            publicUrl: tunnel.state === 'on' ? tunnel.url : null,
            resume: true,
            map: room.obstacles,
            players: roster(room),
            scores: scores(room),
          });
          room.pendingEvents.push({ k: 'join', name: old.name + '（已恢复）' });
          broadcastRoom(room);
          broadcast(room);
          break;
        }
      }
      if (room) addPlayer(room, conn, name);
      else {
        makeRoom(conn, name);
        // 单人模式：建房后自动添加 AI 对手
        if (msg.solo) {
          const rm = conn.player.room;
          if (rm) addBot(rm, 'AI 坦克');
        }
      }
      break;
    }
    case 'input': {
      if (!p || !p.room || p.room.phase !== 'play' || !p.alive) break;
      const inp = p.input;
      const thr = Number(msg.thr), steer = Number(msg.steer), ta = Number(msg.ta);
      inp.thr = Number.isFinite(thr) ? clamp(thr, -1, 1) : 0;
      inp.steer = Number.isFinite(steer) ? clamp(steer, -1, 1) : 0;
      inp.ta = Number.isFinite(ta) ? normAngle(ta) : inp.ta;
      inp.shoot = !!msg.shoot;
      inp.boost = !!msg.boost;
      break;
    }
    case 'start': {
      if (!p || !p.room) break;
      const room = p.room;
      if (p.id !== room.hostId || room.phase !== 'lobby') break;
      startRound(room);
      break;
    }
    case 'ping': {
      const ts = Number(msg.ts);
      if (Number.isFinite(ts)) send(conn, { t: 'pong', ts });
      break;
    }
    case 'pick': {
      // 大厅中选择坦克型号
      if (!p || !p.room || p.room.phase !== 'lobby') break;
      if (msg.type === 'us' || msg.type === 'ru' || msg.type === 'jp') {
        p.type = msg.type;
        p.era = initialEra(msg.type);
        // 单人模式：AI 自动选择与玩家相反的型号（us↔ru；jp 的对手选 ru）
        const opposite = { us: 'ru', ru: 'us', jp: 'ru' }[msg.type];
        for (const q of p.room.players.values()) {
          if (q.isBot && q.type === msg.type) {
            q.type = opposite;
            q.era = initialEra(q.type);
          }
        }
        broadcastRoom(p.room);
      }
      break;
    }
    case 'kick': {
      // 房主踢人：立即移除（不进入 15 秒断线保留），被踢玩家收到 kick 消息
      if (!p || !p.room) break;
      const room2 = p.room;
      if (p.id !== room2.hostId) break; // 只有房主能踢
      const victim = room2.players.get(String(msg.id));
      if (!victim || victim.isBot || victim.id === p.id) break;
      clearTimeout(victim.removeTimer);
      if (victim.conn) {
        send(victim.conn, { t: 'kick' });
        victim.conn.player = null; // 防止 close 处理走 15 秒断线保留
        victim.conn.die();
      }
      removePlayer(room2, victim);
      break;
    }
    case 'list': {
      const list = [...rooms.values()].map((r) => ({
        code: r.code,
        players: r.players.size,
        max: MAX_PLAYERS,
        phase: r.phase,
        host: (r.hostId && r.players.get(r.hostId)) ? r.players.get(r.hostId).name : '',
      }));
      send(conn, { t: 'rooms', rooms: list });
      break;
    }
    case 'tunnel': {
      if (process.env.TK_TUNNEL_DISABLED) {
        send(conn, { t: 'tunnel', state: 'error', error: '此环境未启用公网联机' });
        break;
      }
      if (msg.action === 'start') startTunnel().catch(() => { /* 已内部处理 */ });
      else if (msg.action === 'stop') stopTunnel();
      break;
    }
    case 'leave': {
      if (!p || !p.room) break;
      const room = p.room;
      removePlayer(room, p);
      conn.die();
      break;
    }
    default: break;
  }
}

// ---------------- 主循环 ----------------
// tick 性能统计：诊断高延迟环境下服务器是否掉帧（每 60 秒打印一次平均/最大 tick 耗时）
let tickStats = { n: 0, sum: 0, max: 0 };
let lastTickStat = Date.now();
setInterval(() => {
  const t0 = Date.now();
  const now = t0;
  for (const room of rooms.values()) {
    room.tick++;
    if (room.phase === 'countdown') {
      const prev = Math.ceil(room.phaseT);
      room.phaseT -= 1 / 60;
      const cur = Math.ceil(room.phaseT);
      if (cur !== prev && cur > 0) room.pendingEvents.push({ k: 'tick', n: cur });
      if (room.phaseT <= 0) { room.phase = 'play'; room.pendingEvents.push({ k: 'go' }); }
    } else if (room.phase === 'play') {
      sim(room, 1 / 60, now);
    } else if (room.phase === 'over') {
      room.phaseT -= 1 / 60;
      if (room.phaseT <= 0) startRound(room);
    }
    if (room.tick % SNAP_EVERY === 0) broadcast(room);
  }
  const dt = Date.now() - t0;
  tickStats.n++;
  tickStats.sum += dt;
  if (dt > tickStats.max) tickStats.max = dt;
  if (now - lastTickStat >= 60000) {
    const avg = tickStats.sum / tickStats.n;
    console.log('[tick] ' + tickStats.n + ' ticks 平均 ' + avg.toFixed(2) + 'ms 最大 ' + tickStats.max + 'ms' + (avg > 15 ? ' ⚠ 掉帧' : ''));
    tickStats = { n: 0, sum: 0, max: 0 };
    lastTickStat = now;
  }
}, TICK_MS);

// 心跳：浏览器会自动回复 ws ping，超时则断开
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      const c = p.conn;
      if (!c) continue; // 断线等待恢复的玩家：无连接，跳过心跳（否则 null 访问导致进程崩溃）
      if (now - c.aliveAt > ALIVE_TIMEOUT) c.die();
      else { try { c.socket.write(wsFrame(0x9, Buffer.alloc(0), false)); } catch (e) { /* ignore */ } }
    }
  }
}, PING_EVERY);

// ---------------- HTTP 静态服务 + WebSocket ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { urlPath = '/'; }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// 关闭 Nagle 算法：游戏小包极多，禁止 40ms 小包合并等待，显著降低高延迟网络下的卡顿感
server.on('connection', (socket) => {
  try { socket.setNoDelay(true); } catch (e) { /* ignore */ }
});

server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').split('?')[0] !== WS_PATH) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const conn = makeConn(socket);
  if (head && head.length) feed(conn, head);
});

function lanHint() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function listen() {
  // 云端平台(Render/Glitch)注入 PORT 时必须严格监听该端口；仅本地无 PORT 时才允许自动顺延
  const hasEnvPort = !!process.env.PORT;
  const tryListen = (p) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && !hasEnvPort && p < WANTED_PORT + MAX_PORT_TRIES) {
        console.log('端口 ' + p + ' 被占用，尝试 ' + (p + 1) + ' ...');
        tryListen(p + 1);
      } else {
        console.error('启动失败: ' + err.message);
        process.exit(1);
      }
    });
    server.listen(p, '0.0.0.0', () => {
      actualPort = p;
      const lan = lanHint();
      console.log('============================================');
      console.log('  坦克动荡 服务器已启动');
      console.log('  监听端口: ' + p + (hasEnvPort ? ' (平台注入 PORT)' : ''));
      console.log('  本机访问:  http://127.0.0.1:' + p + '/');
      if (!hasEnvPort) console.log('  局域网:    http://' + lan + ':' + p + '/');
      console.log('  按 Ctrl+C 停止');
      console.log('============================================');
    });
  };
  tryListen(WANTED_PORT);
}

function shutdown() {
  stopTunnel();
  try { server.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

listen();
