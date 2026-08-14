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
const ALIVE_TIMEOUT = 45000;   // 心跳超时
const MAX_MSG = 1 << 20;       // 单条消息上限 1MB

// ---------------- 世界常量（与 public/game.js 保持一致） ----------------
const WORLD = { w: 1600, h: 1200 };
const WALL_T = 24; // 墙厚（碰撞边界在墙内缘）
// 迷宫参数：每回合随机生成新迷宫（DFS 完美迷宫，通道全部连通）
const MAZE_COLS = 10, MAZE_ROWS = 8;
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
const TANK = { r: 22, accel: 340, turn: 3.2, dragF: 0.9, dragL: 3.8, hp: 100, boostMult: 1.3 };
// 坦克类型（玩家开局选择）
const TANK_TYPES = {
  us: {
    name: '美军 M1A2', maxSpeed: 270, back: 0.8, reload: 4, era: 2,
    pen: { front: 0.65, side: 0.85, back: 0.95 },  // 击穿概率
    ammoZone: 'rear',   // 弹药架位于炮塔后方
    hasLoader: false,
  },
  ru: {
    name: '俄军 T90M', maxSpeed: 205, back: 0.35, reload: 6, era: 3,
    pen: { front: 0.3, side: 0.65, back: 0.85 },   // 正面极难击穿
    ammoZone: 'side',   // 弹药架位于侧面中心
    hasLoader: true,    // 自动装弹机：损坏后装填时间翻倍
  },
};
const BULLET = { speed: 620, r: 5, dmg: 30, bounces: 5, life: 5.5, cooldown: 0.35, rapidCd: 0.14 };
const MAG_SIZE = 1;        // 弹匣容量（单发装填）
const PARTS_LIST = ['track', 'turret', 'engine', 'ammo', 'optics', 'loader']; // 可损坏部件（loader 仅俄军）
const FRONT_PARTS = ['track', 'turret', 'engine', 'optics'];         // 正面命中不会直接坏弹药架
const REPAIR_TIME = 2.5;   // 停车维修一个部件所需秒数
const FIRE_TIME = 3;       // 起火持续秒数
const FIRE_DPS = 5;        // 起火每秒伤害
const POWERUP = { max: 4, spawnEvery: 6, life: 20, r: 15 };
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
    if (conn.player) { removePlayer(conn.player.room, conn.player); conn.player = null; }
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
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, alive: p.alive, host: p.id === room.hostId, type: p.type }));
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

function removePlayer(room, p) {
  room.players.delete(p.id);
  if (p.conn) p.conn.player = null;
  if (room.hostId === p.id) {
    const first = [...room.players.values()][0];
    room.hostId = first ? first.id : null;
  }
  room.pendingEvents.push({ k: 'leave', name: p.name });
  if (room.players.size === 0) { rooms.delete(room.code); return; }
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
  p.fireT = 0;
  p.fireDmg = 0;
  p.era = TANK_TYPES[p.type].era;         // 反应装甲按型号重置
}

function startRound(room) {
  room.roundNo++;
  // 每回合生成全新迷宫，并重新计算出生点（移到最近通道）
  room.obstacles = roomMap();
  const usedCells = new Set();
  room.spawns = SPAWNS.map((s) => {
    const f = fitSpawn(room.obstacles, s.x, s.y, TANK.r, WORLD.w, WORLD.h, WALL_T, usedCells);
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

// ---------------- 物理与战斗 ----------------
function collideTankWorld(tk, obstacles) {
  const minX = WALL_T + TANK.r, maxX = WORLD.w - WALL_T - TANK.r;
  const minY = WALL_T + TANK.r, maxY = WORLD.h - WALL_T - TANK.r;
  if (tk.x < minX) { tk.x = minX; if (tk.vx < 0) tk.vx = -tk.vx * 0.3; }
  else if (tk.x > maxX) { tk.x = maxX; if (tk.vx > 0) tk.vx = -tk.vx * 0.3; }
  if (tk.y < minY) { tk.y = minY; if (tk.vy < 0) tk.vy = -tk.vy * 0.3; }
  else if (tk.y > maxY) { tk.y = maxY; if (tk.vy > 0) tk.vy = -tk.vy * 0.3; }
  for (const o of obstacles) {
    const cx = clamp(tk.x, o.x, o.x + o.w);
    const cy = clamp(tk.y, o.y, o.y + o.h);
    const dx = tk.x - cx, dy = tk.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < TANK.r * TANK.r) {
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, ny = dy / d;
      tk.x = cx + nx * TANK.r;
      tk.y = cy + ny * TANK.r;
      const vn = tk.vx * nx + tk.vy * ny;
      if (vn < 0) { tk.vx -= nx * vn * 1.7; tk.vy -= ny * vn * 1.7; }
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
        if (p.parts.loader === false) reload *= 2; // 俄军装弹机损坏
        if (rapid) reload *= 0.5;
        p.reloadT = reload;
        const fire = (ang) => {
          room.bullets.push({
            x: mx, y: my,
            vx: Math.cos(ang) * BULLET.speed, vy: Math.sin(ang) * BULLET.speed,
            ownerId: p.id, bounces: BULLET.bounces, life: BULLET.life,
          });
        };
        if (triple) { fire(tk.ta - 0.18); fire(tk.ta); fire(tk.ta + 0.18); }
        else fire(tk.ta);
        room.pendingEvents.push({ k: 'shot', id: p.id, x: Math.round(mx), y: Math.round(my) });
      }
    }
  }

  // ---- 坦克互撞 ----
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i].tank, b = alive[j].tank;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const min = TANK.r * 2;
      if (d > 0.001 && d < min) {
        const nx = dx / d, ny = dy / d;
        const push = (min - d) / 2;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
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

    // 边界反弹
    if (!dead && b.x < WALL_T + BULLET.r) { b.x = WALL_T + BULLET.r; b.vx = -b.vx; if (--b.bounces < 0) dead = true; }
    if (!dead && b.x > WORLD.w - WALL_T - BULLET.r) { b.x = WORLD.w - WALL_T - BULLET.r; b.vx = -b.vx; if (--b.bounces < 0) dead = true; }
    if (!dead && b.y < WALL_T + BULLET.r) { b.y = WALL_T + BULLET.r; b.vy = -b.vy; if (--b.bounces < 0) dead = true; }
    if (!dead && b.y > WORLD.h - WALL_T - BULLET.r) { b.y = WORLD.h - WALL_T - BULLET.r; b.vy = -b.vy; if (--b.bounces < 0) dead = true; }

    // 障碍碰撞：线段检测（防高速隧穿穿墙），仅在真正撞击表面时反弹并消耗次数
    if (!dead) {
      for (const o of room.obstacles) {
        const hit = segRectHit(px, py, b.x, b.y, o);
        if (hit) {
          b.x = hit.x; b.y = hit.y;
          const vn = b.vx * hit.nx + b.vy * hit.ny;
          if (vn < 0) {
            b.vx -= 2 * vn * hit.nx;
            b.vy -= 2 * vn * hit.ny;
            if (--b.bounces < 0) dead = true;
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
            if (--b.bounces < 0) dead = true;
          }
          break;
        }
      }
    }

    // 命中坦克（模块化损伤：弹药架弱点区域 / 击穿判定 / 反应装甲 / 区域模块损坏）
    if (!dead) {
      for (const q of alive) {
        if (q.id === b.ownerId) continue;
        const t2 = q.tank;
        const dx = t2.x - b.x, dy = t2.y - b.y;
        const rr = TANK.r + BULLET.r;
        if (dx * dx + dy * dy < rr * rr) {
          dead = true;
          if (q.shield) {
            q.shield = false;
            room.pendingEvents.push({ k: 'shield', id: q.id, x: Math.round(t2.x), y: Math.round(t2.y) });
          } else {
            const tt = TANK_TYPES[q.type];
            // 部位判定：子弹方向 vs 坦克正面
            const fwdX = Math.cos(t2.a), fwdY = Math.sin(t2.a);
            const bSpeed = Math.hypot(b.vx, b.vy) || 1;
            const dot = (b.vx * fwdX + b.vy * fwdY) / bSpeed;
            const zone = dot > 0.5 ? 'front' : (dot < -0.5 ? 'back' : 'side');
            // 命中点局部坐标：+x 坦克前方，|y| 横向
            const rx = dx * fwdX + dy * fwdY;
            const ry = -dx * fwdY + dy * fwdX;
            // 弹药架弱点区域（按型号设计）：击中必殉爆
            const ammoHit = tt.ammoZone === 'rear'
              ? (rx < -10 && Math.abs(ry) < 18)   // 美军：炮塔后方
              : (Math.abs(ry) > 16 && Math.abs(rx) < 20); // 俄军：侧面中心
            if (ammoHit) {
              // 弹药架殉爆：立即击毁（弱点命中无视反应装甲）
              q.alive = false;
              q.deadAt = now;
              const killer = room.players.get(b.ownerId);
              if (killer && killer.id !== q.id) {
                killer.kills++;
                room.pendingEvents.push({ k: 'kill', killer: killer.name, victim: q.name, reason: '殉爆', x: Math.round(t2.x), y: Math.round(t2.y) });
              }
              room.pendingEvents.push({ k: 'boom', x: Math.round(t2.x), y: Math.round(t2.y) });
            } else {
              // 击穿判定（按型号与部位；反应装甲存在时更难穿透）
              let pen = tt.pen[zone];
              if (q.era > 0) pen *= 0.55;
              const penetrated = Math.random() < pen;
              if (!penetrated) {
                // 未击穿：反应装甲吸收（或少量跳弹伤害），不掉模块
                const eraLeft = q.era > 0 ? q.era : 0;
                if (q.era > 0) q.era--;
                t2.hp -= Math.max(3, dmg * 0.15);
                room.pendingEvents.push({ k: 'hit', id: q.id, zone, parts: [], pen: false, era: q.era, x: Math.round(b.x), y: Math.round(b.y) });
                if (eraLeft === 0 && t2.hp <= 0) {
                  q.alive = false;
                  q.deadAt = now;
                  const killer = room.players.get(b.ownerId);
                  if (killer && killer.id !== q.id) {
                    killer.kills++;
                    room.pendingEvents.push({ k: 'kill', killer: killer.name, victim: q.name, reason: '车组阵亡', x: Math.round(t2.x), y: Math.round(t2.y) });
                  }
                  room.pendingEvents.push({ k: 'boom', x: Math.round(t2.x), y: Math.round(t2.y) });
                }
              } else {
                // 击穿：全伤害 + 反应装甲消耗 + 区域模块损坏
                const dmg = zone === 'front' ? 20 : (zone === 'back' ? 40 : 30);
                t2.hp -= dmg;
                q.lastHitBy = b.ownerId;
                if (q.era > 0) q.era--;
                const brokenParts = [];
                const breakOne = (pool) => {
                  const avail = pool.filter((n) => q.parts[n]);
                  if (!avail.length) return;
                  const pick = avail[rnd(avail.length)];
                  q.parts[pick] = false;
                  brokenParts.push(pick);
                };
                // 区域模块损坏：发动机固定后方；正面按型号差异
                if (zone === 'front') {
                  if (q.type === 'ru') {
                    // 俄军正面：只可能坏履带或装弹机
                    breakOne(['track', 'loader']);
                  } else {
                    // 美军正面：炮塔优先，履带其次
                    if (Math.random() < 0.7) breakOne(['turret']);
                    else breakOne(['track']);
                  }
                } else if (zone === 'back') {
                  breakOne(['engine']); // 发动机固定位于后方
                } else {
                  breakOne(['track']);
                  if (q.type === 'ru') breakOne(['loader']);
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
                // 殉爆（非弱点区域）：反应装甲失效后概率大幅提升
                const detChance = q.era > 0 ? (zone === 'side' ? 0.05 : zone === 'back' ? 0.1 : 0) : (zone === 'side' ? 0.25 : zone === 'back' ? 0.4 : 0);
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
      const rr = TANK.r + POWERUP.r;
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
      if (room) addPlayer(room, conn, name);
      else makeRoom(conn, name);
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
      if (msg.type === 'us' || msg.type === 'ru') {
        p.type = msg.type;
        p.era = TANK_TYPES[msg.type].era;
        broadcastRoom(p.room);
      }
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
setInterval(() => {
  const now = Date.now();
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
}, TICK_MS);

// 心跳：浏览器会自动回复 ws ping，超时则断开
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      const c = p.conn;
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
