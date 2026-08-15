'use strict';
/* 坦克动荡（多人联机版）—— 浏览器客户端
 * 与服务端 server.js 配合：本地预测自己 + 快照插值渲染他人。
 */
(() => {
  // ---------------- 小工具 ----------------
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, f) => a + (b - a) * f;
  const angLerp = (a, b, f) => {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * f;
  };
  const show = (el, on) => el.classList.toggle('hidden', !on);

  // ---------------- 世界常量（与 server.js 一致） ----------------
  const WORLD = { w: 1600, h: 1200 };
  const WALL_T = 24;
  // 线段与轴对齐矩形碰撞（与服务器 lib-geom.js 一致，本地子弹反弹用）
  function segRectHit(x0, y0, x1, y1, r) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    let txIn = 0, txOut = 1, nxSide = 0;
    if (Math.abs(dx) < 1e-9) {
      if (x0 < r.x || x0 > r.x + r.w) return null;
    } else {
      let t1 = (r.x - x0) / dx;
      let t2 = (r.x + r.w - x0) / dx;
      let n1 = -1, n2 = 1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; const n = n1; n1 = n2; n2 = n; }
      txIn = t1; txOut = t2; nxSide = n1;
    }
    let tyIn = 0, tyOut = 1, nySide = 0;
    if (Math.abs(dy) < 1e-9) {
      if (y0 < r.y || y0 > r.y + r.h) return null;
    } else {
      let t1 = (r.y - y0) / dy;
      let t2 = (r.y + r.h - y0) / dy;
      let n1 = -1, n2 = 1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; const n = n1; n1 = n2; n2 = n; }
      tyIn = t1; tyOut = t2; nySide = n1;
    }
    const tIn = Math.max(txIn, tyIn);
    const tOut = Math.min(txOut, tyOut);
    if (tIn > 0 && tIn <= 1 && tIn <= tOut) {
      return {
        x: x0 + dx * tIn,
        y: y0 + dy * tIn,
        nx: tIn === txIn ? nxSide : 0,
        ny: tIn === tyIn ? nySide : 0,
      };
    }
    return null;
  }
  // 迷宫由服务器每回合随机生成并通过 map 消息下发；初始为简单占位布局
  let mapObstacles = [
    { x: 330, y: 240, w: 240, h: 150 },
    { x: 1030, y: 240, w: 240, h: 150 },
    { x: 330, y: 810, w: 240, h: 150 },
    { x: 1030, y: 810, w: 240, h: 150 },
    { x: 700, y: 525, w: 200, h: 150 },
  ];
  const TANK = { r: 22, l: 52, w: 44, maxSpeed: 240, accel: 340, back: 0.62, turn: 3.2, dragF: 0.9, dragL: 3.8, hp: 100, boostMult: 1.3 };
  const MAG_SIZE = 1;       // 弹匣容量：单发装填（与 server.js 一致）
  const TANK_TYPES = {      // 客户端展示用（与 server.js 一致）
    us: { name: '美军 M1A1标题党', reload: 4, eraMax: 300, pen: 800, penDrop: 100, armor: '600/200/400', armorEra: '900/800/400', color: '#6b8e5a' },
    ru: { name: '俄军 T80U', reload: 6, eraMax: 500, pen: 750, penDrop: 200, armor: '800/250/700', armorEra: '1200/1050/700', color: '#5f7a52' },
  };
  const PALETTE = ['#ff5d5d', '#4fc3f7', '#66bb6a', '#ffee58', '#ff8a65', '#ba68c8', '#4dd0e1', '#f06292', '#aed581', '#90a4ae'];
  const PUP_COLOR = { health: '#4caf50', shield: '#4dd0e1', rapid: '#ffca28', triple: '#ff7043' };
  const PUP_ICON = { health: '回血', shield: '护盾', rapid: '速射', triple: '三连' };
  const INTERP_MS = 20; // 快照插值延迟（60Hz 快照下 20ms 足够平滑，更低感知延迟）

  // ---------------- DOM ----------------
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const mm = $('minimap');
  const mmCtx = mm.getContext('2d');
  // 迷雾用离屏蒙版：黑底画布上擦出可视区（透明），再覆盖到主画布
  // 黑区=迷雾（不透明）、透明区=露出场景；重叠区域无影响
  const fogCanvas = document.createElement('canvas');
  const fogCtx = fogCanvas.getContext('2d');
  const els = {
    topbar: $('topbar'), codeText: $('codeText'), btnCopy: $('btnCopy'),
    pingText: $('pingText'), btnMute: $('btnMute'), btnLeave: $('btnLeave'), btnPub: $('btnPub'),
    countdown: $('countdown'), banner: $('banner'), killfeed: $('killfeed'),
    hud: $('hud'), hpBar: $('hpBar'), hpText: $('hpText'), ammoBox: $('ammoBox'), eraBox: $('eraBox'), buffs: $('buffs'),
    tpUs: $('tp-us'), tpRu: $('tp-ru'),
    partTrack: $('part-track'), partTurret: $('part-turret'), partEngine: $('part-engine'),
    partAmmo: $('part-ammo'), partOptics: $('part-optics'),
    repairBar: $('repairBar'), damageNote: $('damageNote'),
    deathOverlay: $('deathOverlay'), deathText: $('deathText'),
    scoreboard: $('scoreboard'), sbRows: $('sbRows'),
    menu: $('menu'), nameInput: $('nameInput'), btnCreate: $('btnCreate'), btnSolo: $('btnSolo'),
    joinInput: $('joinInput'), btnJoin: $('btnJoin'), errMsg: $('errMsg'),
    btnRefresh: $('btnRefresh'), roomList: $('roomList'),
    lobby: $('lobby'), lobbyCode: $('lobbyCode'), lobbyLink: $('lobbyLink'),
    playerList: $('playerList'), btnStart: $('btnStart'), btnBack: $('btnBack'), lobbyHint: $('lobbyHint'),
    btnTunnel: $('btnTunnel'), tunnelStatus: $('tunnelStatus'),
    boostBtn: $('boostBtn'),
    connOverlay: $('connOverlay'), connText: $('connText'), btnConnCancel: $('btnConnCancel'),
  };

  // ---------------- 状态 ----------------
  let ws = null;
  let myId = null;
  let roomCode = null;
  let hostId = null;
  let myName = localStorage.getItem('tk_name') || ('玩家' + Math.floor(100 + Math.random() * 900));
  let phase = 'lobby';
  let phaseT = 0;
  let winner = null;
  let lan = '127.0.0.1';
  let ping = -1;
  let lastPongAt = 0;       // 应用层心跳：最后收到 pong 的时间（检测僵尸连接）
  let intentionalClose = false;
  let reconnectTimer = null;
  let gameShown = false; // 是否已切换到战斗界面（HUD 显示）

  // 房间浏览 / 公网通道
  let intent = { join: false, room: null }; // 连接建立后的意图
  let browse = false;
  let joined = false;
  let browseTimer = null;
  let rooms = [];
  let tunnelState = 'off';
  let tunnelUrl = null;
  let tunnelError = '';

  // 触屏（严格检测：仅当主输入设备是触摸时才启用手机 UI，避免触屏笔记本误判）
  const touch = {
    mode: (() => {
      const mq = (q) => (window.matchMedia ? window.matchMedia(q) : null);
      const coarse = mq('(pointer: coarse)');
      const anyCoarse = mq('(any-pointer: coarse)');
      const anyFine = mq('(any-pointer: fine)');
      if (coarse && coarse.matches) return true;                       // 手机/平板
      if (anyCoarse && anyFine && anyCoarse.matches && !anyFine.matches) return true; // 只有触摸指针的设备
      return false;                                                    // 台式机/触屏笔记本(主输入为鼠标)
    })(),
    aim: null,      // 右半屏瞄准摇杆 {id, sx, sy, dx, dy}
    boost: false,
  };
  const JOY_R = 58;

  let snaps = [];           // 快照缓冲
  let players = new Map();  // id -> 渲染状态
  let bullets = [];         // 渲染用子弹
  let pups = [];            // 渲染用道具
  let particles = [];

  let pred = null;          // 自己坦克的本地预测 {x,y,a,ta,vx,vy}
  let selfHp = 100;
  let selfAlive = false;
  let selfBuffs = { shd: 0, rap: 0, trp: 0 };
  let localMag = MAG_SIZE;      // 本地弹药显示（即时反馈）
  let localReload = 0;          // 本地换弹计时
  let localFireCd = 0;          // 本地开火冷却（仅用于弹药显示节奏）
  let predBullets = [];         // 本地预测子弹（自己开火即时显示，服务器快照接管前使用）
  let selfParts = { track: true, turret: true, engine: true, ammo: true, optics: true, loader: true }; // 本地部件状态
  let selfRepair = 0;           // 维修进度(秒)
  let selfFire = 0;             // 起火剩余秒数
  let selfType = 'us';          // 坦克型号
  let selfEra = 300;            // 反应装甲血量（服务器权威同步）

  const keys = {};
  const mouse = { x: 0, y: 0, down: false, active: false };
  let mouseAngle = 0;
  let autoTurret = true; // 无瞄准输入时炮塔自动对齐车体（开局炮管朝车头，防止"倒着走"观感）
  let lastInputSent = 0;
  let lastPingSent = 0;
  let hudTimer = 0;

  const cam = { x: WORLD.w / 2, y: WORLD.h / 2, s: 1 };
  const camTarget = { x: WORLD.w / 2, y: WORLD.h / 2, s: 1 };

  let muted = localStorage.getItem('tk_muted') === '1';
  let audio = null;
  let audioReady = false;

  // ---------------- 音效 ----------------
  function ensureAudio() {
    if (audioReady) return;
    try {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      audioReady = true;
    } catch (e) { /* 不支持则静音 */ }
  }
  function tone(freq, dur, type, vol, slideTo, delay) {
    if (!audio || muted) return;
    try {
      const t = audio.currentTime + (delay || 0);
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* ignore */ }
  }
  function noiseBurst(dur, vol, freq, delay) {
    if (!audio || muted) return;
    try {
      const t = audio.currentTime + (delay || 0);
      const n = Math.floor(audio.sampleRate * dur);
      const buf = audio.createBuffer(1, n, audio.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = audio.createBufferSource();
      src.buffer = buf;
      const f = audio.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = freq || 900;
      const g = audio.createGain(); g.gain.value = vol;
      src.connect(f); f.connect(g); g.connect(audio.destination);
      src.start(t);
    } catch (e) { /* ignore */ }
  }
  const sfx = {
    shot: () => tone(620, 0.08, 'square', 0.10, 170),
    hit: () => { noiseBurst(0.07, 0.22, 1300); tone(210, 0.1, 'square', 0.13, 80); },
    boom: () => { noiseBurst(0.4, 0.45, 500); tone(150, 0.4, 'sine', 0.3, 40); },
    shield: () => tone(520, 0.14, 'sine', 0.2, 780),
    pick: () => { tone(660, 0.07, 'sine', 0.16); tone(990, 0.1, 'sine', 0.16, null, 0.06); },
    tick: () => tone(440, 0.06, 'sine', 0.16),
    go: () => tone(880, 0.28, 'sine', 0.26),
    kill: () => { noiseBurst(0.25, 0.35, 700); tone(880, 0.12, 'square', 0.16); },
    win: () => { tone(523, 0.14, 'sine', 0.2); tone(659, 0.14, 'sine', 0.2, null, 0.12); tone(784, 0.14, 'sine', 0.2, null, 0.24); tone(1047, 0.3, 'sine', 0.24, null, 0.36); },
  };

  // ---------------- 网络 ----------------
  function connect(room, opts) {
    opts = opts || {};
    browse = !!opts.browse;
    joined = false;
    intent = browse ? { join: false, room: null } : { join: true, room: room || null, solo: !!opts.solo };
    // 快照本连接的意图：连接生命周期内不受后续 joinRoom/浏览重连影响（修复竞态导致 join 丢失）
    const myIntent = { join: intent.join, room: intent.room, solo: intent.solo };
    intentionalClose = false;
    if (!browse) { // 浏览模式(房间列表扫描)是静默连接，不显示遮罩
      show(els.connOverlay, true);
      show(els.btnConnCancel, reconnectTimer != null);
      els.connText.textContent = '连接中…';
    }
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    let conn;
    try { conn = new WebSocket(proto + location.host + '/ws'); } catch (e) { onConnFail('无法连接服务器'); return; }
    ws = conn;
    lastPongAt = performance.now();
    conn.onopen = () => {
      if (myIntent.join) conn.send(JSON.stringify({ t: 'join', name: myName, room: myIntent.room, resume: myId, solo: !!myIntent.solo }));
      else if (conn.__pendingJoin !== undefined) {
        // 连接建立期间玩家已点击加入：按待加入发送
        conn.send(JSON.stringify({ t: 'join', name: myName, room: conn.__pendingJoin, resume: myId, solo: !!conn.__pendingSolo }));
      } else { conn.send(JSON.stringify({ t: 'list' })); startBrowse(); }
    };
    conn.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleMsg(m);
    };
    conn.onclose = () => {
      if (ws === conn) ws = null; // 仅当是当前连接时才清空（避免旧连接关闭覆盖新连接）
      stopBrowse();
      if (intentionalClose) { showMenu(); return; }
      if (myIntent.join === false) { // 纯浏览连接：静默重连
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (intent.join === true) { // 期间已被 joinRoom 接管：按加入连接
            connect(intent.room, { browse: false });
          } else {
            connect(null, { browse: true });
          }
        }, 3000);
        return;
      }
      // 已发起加入：按加入意图重连（避免断线后丢失 join 请求）
      els.connText.textContent = '连接断开，正在重连…';
      show(els.connOverlay, true);
      show(els.btnConnCancel, true);
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(myIntent.room, { browse: false }); }, 1800);
    };
    conn.onerror = () => { /* onclose 处理 */ };
  }
  function startBrowse() {
    stopBrowse();
    browseTimer = setInterval(() => {
      if (browse && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'list' }));
    }, 4000);
  }
  function stopBrowse() {
    if (browseTimer) { clearInterval(browseTimer); browseTimer = null; }
  }
  function ensureBrowse() {
    if (!browse && !joined && (!ws || ws.readyState > 1)) connect(null, { browse: true });
  }
  function onConnFail(text) {
    els.errMsg.textContent = text;
    show(els.connOverlay, false);
  }

  // ---------------- 消息处理 ----------------
  function handleMsg(m) {
    switch (m.t) {
      case 'hello': {
        myId = m.id;
        roomCode = m.code;
        hostId = m.hostId;
        phase = m.phase;
        phaseT = m.phaseT || 0;
        winner = m.winner || null;
        lan = m.lan || lan;
        if (Array.isArray(m.map) && m.map.length) mapObstacles = m.map;
        joined = true;
        browse = false;
        stopBrowse();
        tunnelUrl = m.publicUrl || null;
        tunnelState = tunnelUrl ? 'on' : 'off';
        show(els.connOverlay, false);
        els.codeText.textContent = roomCode;
        els.pingText.textContent = '-';
        ping = -1;
        snaps = [];
        players.clear();
        bullets = [];
        pups = [];
        if (phase === 'lobby') showLobby();
        else { showGame(); showBanner('你已加入对局，旁观中'); }
        updateTunnelUI();
        break;
      }
      case 'room': {
        roomCode = m.code;
        hostId = m.hostId;
        phase = m.phase;
        if (m.publicUrl) { tunnelUrl = m.publicUrl; tunnelState = 'on'; }
        renderLobby(m.players);
        updateTunnelUI();
        break;
      }
      case 'map': {
        if (Array.isArray(m.obstacles) && m.obstacles.length) {
          mapObstacles = m.obstacles; // 每回合新迷宫
        }
        break;
      }
      case 'rooms': {
        rooms = m.rooms || [];
        renderRoomList();
        show(els.connOverlay, false); // 双保险：收到房间列表即关闭遮罩
        break;
      }
      case 'tunnel': {
        tunnelState = m.state;
        if (m.state === 'on') { tunnelUrl = m.url || null; tunnelError = ''; }
        else if (m.state === 'error') { tunnelUrl = null; tunnelError = m.error || '建立失败'; }
        else if (m.state === 'off') { tunnelUrl = null; }
        updateTunnelUI();
        break;
      }
      case 'snap': {
        if (!gameShown && m.phase !== 'lobby') { showGame(); }
        m.recvAt = performance.now();
        snaps.push(m);
        while (snaps.length > 8) snaps.shift();
        phase = m.phase;
        phaseT = m.phaseT;
        winner = m.winner;
        processEvents(m.events || []);
        reconcileSelf(m);
        updateCountdown(m);
        break;
      }
      case 'pong': {
        ping = Math.round(performance.now() - m.ts);
        lastPongAt = performance.now();
        break;
      }
      case 'err': {
        els.errMsg.textContent = m.msg;
        intentionalClose = true; // 加入失败等错误：不自动重连
        show(els.connOverlay, false);
        break;
      }
      default: break;
    }
  }

  // 自己坦克：用最新快照做温和校正
  function reconcileSelf(s) {
    const me = s.players.find((pp) => pp.id === myId);
    if (!me || me.x == null) {
      if (!me || !me.alive) { pred = null; }
      selfAlive = false;
      return;
    }
    selfAlive = me.alive;
    selfHp = me.hp;
    selfBuffs = { shd: me.shd, rap: me.rap, trp: me.trp };
    // 弹药校正：与服务器偏差过大时以服务器为准
    if (me.mag != null && Math.abs(me.mag - localMag) > 2) localMag = me.mag;
    // 部件状态同步（服务器权威）
    if (Array.isArray(me.prt)) {
      selfParts.track = me.prt[0];
      selfParts.turret = me.prt[1];
      selfParts.engine = me.prt[2];
      selfParts.ammo = me.prt[3];
      selfParts.optics = me.prt[4];
      selfParts.loader = me.prt[5] !== false;
      selfRepair = me.rp || 0;
      selfFire = me.fr || 0;
      if (me.ty) selfType = me.ty;
      if (me.era != null) selfEra = me.era;
    }
    if (!me.alive) { pred = null; return; }
    if (!pred) {
      pred = { x: me.x, y: me.y, a: me.a, ta: me.ta, vx: 0, vy: 0 };
      return;
    }
    const dx = me.x - pred.x, dy = me.y - pred.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 140) { pred.x = me.x; pred.y = me.y; }          // 大误差硬校正
    else { pred.x += dx * 0.55; pred.y += dy * 0.55; }         // 小误差平滑收敛
    pred.a = angLerp(pred.a, me.a, 0.5);
  }

  // ---------------- 事件（音效 / 播报 / 粒子） ----------------
  function distCam(x, y) {
    return Math.hypot(x - cam.x, y - cam.y);
  }
  function processEvents(events) {
    for (const e of events) {
      const v = clamp(1 - distCam(e.x || cam.x, e.y || cam.y) / 1600, 0.12, 1);
      switch (e.k) {
        case 'shot':
          sfx.shot();
          if (e.id === myId) { spawnParticles(e.x, e.y, '#ffd54f', 4, 1.6); }
          break;
        case 'hit':
          sfx.hit();
          spawnParticles(e.x, e.y, '#ff8a65', 7, 2.2);
          if (e.id === myId) zoneNote(e.zone, e.parts, e.pen);
          break;
        case 'boom':
          sfx.boom();
          spawnParticles(e.x, e.y, '#ff7043', 22, 4.5);
          spawnParticles(e.x, e.y, '#ffd54f', 10, 3.2);
          break;
        case 'shield':
          sfx.shield();
          spawnParticles(e.x, e.y, '#4dd0e1', 8, 2.4);
          break;
        case 'pick':
          sfx.pick();
          spawnParticles(e.x, e.y, PUP_COLOR[e.type] || '#fff', 8, 2.2);
          break;
        case 'tick':
          sfx.tick();
          break;
        case 'go':
          sfx.go();
          showBanner('开战！');
          break;
        case 'round':
          showBanner('第 ' + e.n + ' 回合');
          break;
        case 'win':
          sfx.win();
          showBanner(e.name ? '🏆 ' + e.name + ' 获胜！' : '平局！');
          break;
        case 'fire':
          sfx.boom();
          if (e.id === myId) showDamageNote('🔥 起火了！持续掉血', false);
          break;
        case 'kill':
          sfx.kill();
          addKillfeed(e.killer, e.victim, e.reason);
          break;
        case 'repair':
          sfx.pick();
          if (e.id === myId) {
            const pname = { track: '履带', turret: '炮塔', engine: '发动机', ammo: '弹药架', optics: '观瞄' }[e.part] || e.part;
            showDamageNote('✅ ' + pname + ' 已修复', true);
          }
          break;
        case 'join':
          addKillfeed(null, e.name + ' 加入');
          break;
        case 'leave':
          addKillfeed(null, e.name + ' 离开');
          break;
        default: break;
      }
    }
  }
  let noteTimer = null;
  function showDamageNote(text, good) {
    els.damageNote.textContent = text;
    els.damageNote.classList.toggle('good', !!good);
    show(els.damageNote, true);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => show(els.damageNote, false), 2200);
  }
  function zoneNote(zone, parts, pen) {
    const zname = { front: '正面命中', side: '侧面命中', back: '背面命中' }[zone] || '命中';
    const pnames = (parts || []).map((p) => ({ track: '履带', turret: '炮塔', engine: '发动机', ammo: '弹药架', optics: '观瞄', loader: '装弹机' }[p] || p)).join('、');
    let text;
    if (pen) text = pnames ? zname + '！' + pnames + ' 损坏' : zname + '！击穿';
    else text = pnames ? '未击穿·' + zname + '！' + pnames + ' 损坏' : '未击穿（跳弹）';
    showDamageNote(text, !!pen);
  }
  function addKillfeed(killer, victim, reason) {
    const div = document.createElement('div');
    div.className = 'kf';
    if (killer) div.innerHTML = '<b>' + esc(killer) + '</b> 击毁 <i>' + esc(victim) + '</i>' + (reason === '殉爆' ? ' <span style="color:#ffd54f">💥殉爆</span>' : '');
    else div.textContent = victim;
    els.killfeed.appendChild(div);
    while (els.killfeed.children.length > 5) els.killfeed.removeChild(els.killfeed.firstChild);
    setTimeout(() => { if (div.parentNode) div.parentNode.removeChild(div); }, 4200);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  let bannerTimer = null;
  function showBanner(text) {
    els.banner.textContent = text;
    show(els.banner, true);
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => show(els.banner, false), 1600);
  }
  function updateCountdown(m) {
    if (m.phase === 'countdown') {
      const n = Math.ceil(m.phaseT);
      els.countdown.textContent = n > 0 ? n : '';
      show(els.countdown, true);
    } else {
      show(els.countdown, false);
    }
  }

  // ---------------- 粒子 ----------------
  function spawnParticles(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.3 + Math.random() * 0.7) * speed;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.4 + Math.random() * 0.5,
        maxLife: 0.9,
        size: 2 + Math.random() * 3.5,
        color,
      });
    }
    if (particles.length > 400) particles.splice(0, particles.length - 400);
  }

  // ---------------- 输入（键盘 / 鼠标 / 触屏） ----------------
  window.addEventListener('keydown', (e) => {
    ensureAudio();
    if (e.code === 'KeyM') { toggleMute(); return; }
    keys[e.code] = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('pointerdown', (e) => {
    ensureAudio();
    if (e.pointerType === 'touch') return;
    if (e.target === canvas) { mouse.down = true; mouse.active = true; }
  });
  window.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') mouse.down = false; });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    if (e.target === canvas) { mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true; autoTurret = false; }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('touchstart', (e) => {
    if (e.target === canvas) e.preventDefault();
  }, { passive: false });

  // 触屏控制：右半屏瞄准摇杆（原生 touch 事件，按住开火）+ 左下十字键移动 + 独立开火键
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const x = t.clientX;
      // 只有右半屏创建瞄准摇杆；移动用固定十字键
      if (x >= canvas.clientWidth * 0.5 && !touch.aim) {
        touch.aim = { id: t.identifier, sx: x, sy: t.clientY, dx: 0, dy: 0, at: Date.now() };
      }
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const j = touch.aim && touch.aim.id === t.identifier ? touch.aim : null;
      if (!j) continue;
      let dx = t.clientX - j.sx, dy = t.clientY - j.sy;
      const len = Math.hypot(dx, dy);
      if (len > JOY_R) { dx = dx / len * JOY_R; dy = dy / len * JOY_R; }
      j.dx = dx; j.dy = dy;
      j.at = Date.now();
      if (len > 8) mouseAngle = Math.atan2(dy, dx);
    }
  }, { passive: false });
  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (touch.aim && touch.aim.id === t.identifier) touch.aim = null;
    }
  };
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);
  // 瞄准摇杆超时兜底：抬起事件丢失时自动清除
  setInterval(() => {
    const t = Date.now();
    if (touch.aim && t - touch.aim.at > 2000) touch.aim = null;
  }, 500);

  // 十字方向键 + 开火键（触屏模式）
  const dpad = { up: false, down: false, left: false, right: false };
  let fireHeld = false;
  if (touch.mode) {
    const bindDpad = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      const on = (e) => { e.preventDefault(); dpad[key] = true; };
      const off = () => { dpad[key] = false; };
      el.addEventListener('pointerdown', on);
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
      el.addEventListener('pointerleave', off);
      el.addEventListener('touchstart', on, { passive: false });
      el.addEventListener('touchend', off);
      el.addEventListener('touchcancel', off);
    };
    bindDpad('dpad-up', 'up');
    bindDpad('dpad-down', 'down');
    bindDpad('dpad-left', 'left');
    bindDpad('dpad-right', 'right');
    const fireEl = document.getElementById('btnFire');
    if (fireEl) {
      const fireOn = (e) => { e.preventDefault(); fireHeld = true; };
      const fireOff = () => { fireHeld = false; };
      fireEl.addEventListener('pointerdown', fireOn);
      fireEl.addEventListener('pointerup', fireOff);
      fireEl.addEventListener('pointercancel', fireOff);
      fireEl.addEventListener('pointerleave', fireOff);
      fireEl.addEventListener('touchstart', fireOn, { passive: false });
      fireEl.addEventListener('touchend', fireOff);
      fireEl.addEventListener('touchcancel', fireOff);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'input', thr: 0, steer: 0, ta: mouseAngle, shoot: false, boost: false }));
    }
  });

  function currentInput() {
    const up = keys.KeyW || keys.ArrowUp;
    const down = keys.KeyS || keys.ArrowDown;
    const left = keys.KeyA || keys.ArrowLeft;
    const right = keys.KeyD || keys.ArrowRight;
    let thr = (up ? 1 : 0) - (down ? 1 : 0);
    let steer = (right ? 1 : 0) - (left ? 1 : 0);
    let ta = autoTurret ? (pred ? pred.a : mouseAngle) : mouseAngle;
    let shoot = mouse.down || keys.Space;
    let boost = !!(keys.ShiftLeft || keys.ShiftRight);
    if (touch.mode) {
      // 十字方向键移动（固定 UI，量化 ±1）
      thr = clamp(thr + ((dpad.up ? 1 : 0) - (dpad.down ? 1 : 0)), -1, 1);
      steer = clamp(steer + ((dpad.right ? 1 : 0) - (dpad.left ? 1 : 0)), -1, 1);
      if (touch.aim) {
        const len = Math.hypot(touch.aim.dx, touch.aim.dy);
        if (len > 8) { ta = Math.atan2(touch.aim.dy, touch.aim.dx); autoTurret = false; }
        // 摇杆只负责瞄准，不再自动开火（取消"按住摇杆即开火"，避免中心误触）
      }
      if (touch.boost) boost = true;
      if (fireHeld) shoot = true; // 独立开火键（按住连发）
    }
    return { thr, steer, ta, shoot, boost };
  }
  function sendInput(now) {
    if (now - lastInputSent < 25) return;
    lastInputSent = now;
    if (!ws || ws.readyState !== 1 || phase !== 'play' || !selfAlive) return;
    const inp = currentInput();
    ws.send(JSON.stringify({ t: 'input', thr: inp.thr, steer: inp.steer, ta: inp.ta, shoot: inp.shoot, boost: inp.boost }));
  }
  function sendPing(now) {
    if (now - lastPingSent < 3000) return;
    lastPingSent = now;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
  }

  // ---------------- 本地预测（与服务端同款物理） ----------------
  function stepPred(dt) {
    if (!pred || phase !== 'play' || !selfAlive) return;
    const inp = currentInput();
    const tk = pred;
    const f = { x: Math.cos(tk.a), y: Math.sin(tk.a) };
    const px = -f.y, py = f.x;
    // 部件效果：履带坏不能动，发动机坏限速
    const thr = (selfParts.track ? inp.thr : 0) * (inp.thr < 0 ? TANK.back : 1);
    tk.vx += f.x * thr * TANK.accel * dt;
    tk.vy += f.y * thr * TANK.accel * dt;
    let fwd = tk.vx * f.x + tk.vy * f.y;
    let lat = tk.vx * px + tk.vy * py;
    const dragF = inp.thr !== 0 ? TANK.dragF : 1.7;
    fwd *= Math.exp(-dragF * dt);
    lat *= Math.exp(-TANK.dragL * dt);
    tk.vx = f.x * fwd + px * lat;
    tk.vy = f.y * fwd + py * lat;
    const spd = TANK.maxSpeed * (selfParts.engine ? 1 : 0.45) * (inp.boost ? TANK.boostMult : 1);
    const sp = Math.hypot(tk.vx, tk.vy);
    if (sp > spd) { tk.vx *= spd / sp; tk.vy *= spd / sp; }
    tk.x += tk.vx * dt;
    tk.y += tk.vy * dt;
    tk.a += inp.steer * TANK.turn * dt;
    tk.ta = autoTurret ? tk.a : mouseAngle;
    collideTankWorld(tk);
  }
  function collideTankWorld(tk) {
    const minX = WALL_T + TANK.r, maxX = WORLD.w - WALL_T - TANK.r;
    const minY = WALL_T + TANK.r, maxY = WORLD.h - WALL_T - TANK.r;
    if (tk.x < minX) { tk.x = minX; if (tk.vx < 0) tk.vx = -tk.vx * 0.3; }
    else if (tk.x > maxX) { tk.x = maxX; if (tk.vx > 0) tk.vx = -tk.vx * 0.3; }
    if (tk.y < minY) { tk.y = minY; if (tk.vy < 0) tk.vy = -tk.vy * 0.3; }
    else if (tk.y > maxY) { tk.y = maxY; if (tk.vy > 0) tk.vy = -tk.vy * 0.3; }
    for (const o of mapObstacles) {
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

  // ---------------- 快照插值 ----------------
  function interpState(now) {
    const t = now - INTERP_MS;
    let a = null, b = null, f = 0;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].recvAt <= t) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    }
    if (!a) a = snaps[snaps.length - 1];
    if (a && b && b.recvAt > a.recvAt) f = clamp((t - a.recvAt) / (b.recvAt - a.recvAt), 0, 1);
    return { a, b, f };
  }
  function snapshotPlayer(snap, id) {
    if (!snap) return null;
    return snap.players.find((p) => p.id === id) || null;
  }

  // ---------------- 相机 ----------------
  function updateCam(dt, selfPos) {
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const follow = selfPos && selfAlive && phase === 'play';
    if (follow) {
      camTarget.x = selfPos.x;
      camTarget.y = selfPos.y;
      if (touch.mode) {
        // 手机屏小：放大视野聚焦自身，坦克更大更清晰
        camTarget.s = Math.max(1.0, Math.min(vw / 700, vh / 450));
      } else {
        camTarget.s = Math.max(0.7, Math.min(vw / 1000, vh / 760));
      }
    } else {
      camTarget.x = WORLD.w / 2;
      camTarget.y = WORLD.h / 2;
      camTarget.s = Math.min(vw / (WORLD.w + 80), vh / (WORLD.h + 80));
    }
    const k = 1 - Math.exp(-4 * dt);
    cam.x += (camTarget.x - cam.x) * k;
    cam.y += (camTarget.y - cam.y) * k;
    cam.s += (camTarget.s - cam.s) * k;
  }

  // ---------------- 绘制 ----------------
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawWorld(st, now) {
    // 背景
    ctx.fillStyle = '#0d1220';
    ctx.fillRect(-40, -40, WORLD.w + 80, WORLD.h + 80);
    // 网格
    ctx.strokeStyle = 'rgba(120, 150, 210, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= WORLD.w; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, WORLD.h); }
    for (let y = 0; y <= WORLD.h; y += 100) { ctx.moveTo(0, y); ctx.lineTo(WORLD.w, y); }
    ctx.stroke();
    // 墙壁
    ctx.strokeStyle = '#2c3e60';
    ctx.lineWidth = WALL_T * 2;
    ctx.strokeRect(WALL_T, WALL_T, WORLD.w - WALL_T * 2, WORLD.h - WALL_T * 2);
    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 2;
    ctx.strokeRect(WALL_T, WALL_T, WORLD.w - WALL_T * 2, WORLD.h - WALL_T * 2);
    // 障碍
    for (const o of mapObstacles) {
      ctx.fillStyle = '#1c2740';
      rr(o.x, o.y, o.w, o.h, 8); ctx.fill();
      ctx.strokeStyle = '#33456b';
      ctx.lineWidth = 3;
      rr(o.x + 3, o.y + 3, o.w - 6, o.h - 6, 6); ctx.stroke();
      ctx.fillStyle = 'rgba(90, 120, 180, 0.12)';
      ctx.fillRect(o.x + 10, o.y + 10, o.w - 20, o.h - 20);
    }

    // 道具
    for (const pu of pups) {
      drawPup(pu, now);
    }
    // 子弹：远程用插值快照，自己的用本地预测（即时反馈，避免等服务器往返）
    for (const b of bullets) {
      if (b.o === myId) continue; // 自己的子弹由本地预测渲染
      const tx = b.x - b.vx * 0.045, ty = b.y - b.vy * 0.045;
      ctx.strokeStyle = 'rgba(255, 210, 110, 0.55)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = '#fff3cf';
      ctx.beginPath(); ctx.arc(b.x, b.y, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255, 200, 90, 0.35)';
      ctx.beginPath(); ctx.arc(b.x, b.y, 7.5, 0, Math.PI * 2); ctx.fill();
    }
    for (const pb of predBullets) {
      const tx = pb.x - pb.vx * 0.045, ty = pb.y - pb.vy * 0.045;
      ctx.strokeStyle = 'rgba(255, 235, 170, 0.7)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.fillStyle = '#fffbe8';
      ctx.beginPath(); ctx.arc(pb.x, pb.y, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255, 220, 130, 0.45)';
      ctx.beginPath(); ctx.arc(pb.x, pb.y, 8, 0, Math.PI * 2); ctx.fill();
    }
    // 坦克
    for (const p of players.values()) {
      if (p.render) drawTank(p, now);
    }
    // 粒子
    ctx.globalCompositeOperation = 'lighter';
    for (const pt of particles) {
      const a = pt.life / pt.maxLife;
      ctx.globalAlpha = a * 0.9;
      ctx.fillStyle = pt.color;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.size * (0.5 + a * 0.5), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    drawFog();
  }

  // 观瞄失效迷雾：平时无迷雾；观瞄设备损坏后进入全黑状态，仅坦克周围留一点光
  // 实现：离屏黑底蒙版 → 擦出自身周围可视圈（透明）→ 覆盖到主画布
  function drawFog() {
    if (phase !== 'play' || !pred || !selfAlive) return;
    if (selfParts.optics) return;      // 观瞄正常：不画迷雾
    const vx = pred.x, vy = pred.y;
    const selfR = 70;                  // 观瞄损坏：坦克周围留一点光
    const dprF = Math.min(window.devicePixelRatio || 1, 2);
    const vwF = canvas.clientWidth, vhF = canvas.clientHeight;
    // 1) 蒙版：全屏黑底（设备像素）
    if (fogCanvas.width !== canvas.width || fogCanvas.height !== canvas.height) {
      fogCanvas.width = canvas.width;
      fogCanvas.height = canvas.height;
    }
    fogCtx.setTransform(1, 0, 0, 1, 0, 0);
    fogCtx.globalCompositeOperation = 'source-over';
    fogCtx.fillStyle = '#000';
    fogCtx.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
    // 2) 擦除自身周围可视圈 → 透明（变换与主画布相机一致：世界 → 设备像素）
    fogCtx.save();
    fogCtx.translate(vwF / 2 * dprF, vhF / 2 * dprF);
    fogCtx.scale(cam.s, cam.s);
    fogCtx.translate(-cam.x, -cam.y);
    fogCtx.globalCompositeOperation = 'destination-out';
    fogCtx.fillStyle = '#fff';
    fogCtx.beginPath();
    fogCtx.arc(vx, vy, selfR, 0, Math.PI * 2);
    fogCtx.fill();
    fogCtx.restore();
    // 3) 蒙版覆盖到主画布（黑区盖住场景=迷雾，透明区露出场景）
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(fogCanvas, 0, 0);
    ctx.restore();
  }

  function drawPup(pu, now) {
    const c = PUP_COLOR[pu.type] || '#fff';
    const pulse = 1 + Math.sin(now / 250) * 0.08;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.arc(pu.x, pu.y + 4, 16 * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(pu.x, pu.y, 14 * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(pu.x, pu.y, 14 * pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#0d1220';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(PUP_ICON[pu.type] || '?', pu.x, pu.y + 0.5);
    // 剩余时间
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(Math.ceil(pu.life) + 's', pu.x, pu.y - 22);
  }

  // ---------------- 坦克贴图（SVG 精细绘制，车头朝右） ----------------
    const TANK_SVG = {
    usBody: 'data:image/png;base64,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',
    usTurret: 'data:image/png;base64,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',
    ruBody: 'data:image/png;base64,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',
    ruTurret: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGgAAAA/CAYAAAAMl43uAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAABsxSURBVHhe7Xz3cxxXkiZk6OC9JTxIiiA82nvvG91Ad6MbaLiGBw0IGtGKRiIljQwpabSrGWkpb067mh2t5lY7u7GxNu4u7uLifrl/6Lv4slDdADm60N5d7BwJZkRFddUrA7x8+V7ml19WUdH/BxIKauDz6BEOabGYi+Hh9qfyR5QXLy4iHB6FzzsMr2cQ8Zg1r6Cg3wSreeCpwv6YEgzo4PMOwecdhdtVUIbTPgqDvhtORx9czj44bINPFfX/QgwD/dKRyag/36FtLbUIhkw4fyGHs+eymJkLYGVtXNotpn7o9Mfh9Y/A7TuxQ0Ej8ttpH4Lbqcmfbz9cA5ejcPxU/o1i0B1HdfVB6cCy/UUwGQqdbneegNH0ghybzIoiVbHY+xBN9KO8ch/evLcJm60Hen07vJ4RWMzH5drDTZVwOQfFqtyuIXR21z9V1M8Rna53V0dtnlrOH59eSj7SiTr9MTmn1XSACu0+WvfINZGQFaurY7hwMYnOjlLUVD0Lu3UItChVQU7ncditw4/c+1S2pb29DnrTcei1ilU4rLpdnXXp7AYW5+MoqTqA9s56VFQ9L+1VVQdknxj3IBTUwqA/IvvsXDB/jSo9XYqV3Lm7jMHBBjhsw3DYFau0WpT3PpWHJDPjhc11Ao1NJejoqEXAa8l31Pm1pZ/sNHVdcTmGRakT43bZYmMm2WgVFvMx8eZczn5EQmY01pXKxvvGokZ8++evw25XLJDS0Vorv02GPnS0Vf/ku/eELK4kEY2bMT3nxfxSRDqDVtTcUIlPPvmlHDfXlODQviL5bbMPwxfgtNQLraZLzpmNfeDI146cQDiqx1jchPG4GRPjipIXF0NITFjlGq9nSM5RmcNDbfnO39gYR9vhMjn2uHQwm16A3ToAp2MPu+Qff/4aJibtSGXcsNh7QSva2V5e8jwO7VcUQ0uxWZSYpq1tP1qa96Oi7Bm0NFZJe2NjuexDEQ3G4gbE4zqMjSnT4+SkBcmEDcmEXZTEc8GABk7HCSQmbPl3lhwskqnObuuTzWYtOCN7SmrrD+X/8alZD1JTLlidvaIkvWG3c8ARbLP0g7FNdeUzCId0CAQGoNd1Ym0tiiuXF+V6o7EfZWXP4cfff4qPHtzFxIQOdvsRaaP1cEslHeBU2NRQIgpLJe0yBS4vplBySBkI779/HS5XL0xG5V6jfg+uSVNzDiQzVoRjygj3BrQwmBXFlJYWoaurEewYdqrN+gL0ui6MDLejsWEfAj4jxmMujEUUdKChoQTtnTVwOAue19Bgq/z+8MOX0d1Zi3feOwmP9ygc9l50d1UiGrYgmbSI0nWaF8RJmJ4qWO8XX92AwdAhA0M9t2ckljAhPWNDasoGt38IpzanUF6ljF5Vpmf8iMdMcs7jNMBkOI7KiiJBBqIRE06fnIXXrRP3WL1Hr+uBxz0Is+moMvINRzE60gGtph09XTUoPlSE27dOShvXJypfvTcUGkEspoXfpwSrhw4UYXSkDW2HK+W4ubEU7a1Vokj1nidSKqufx/WbG5iecyOddSA8ZoTJqkwhpeXPyd5g6MPwSEd+/g8FuNjbMZMNQqftFsuS63THZHpyO7k2KSPd7xtGwD+67QwMYnCgGf19DSCyYLMoymxtKceXnyvOB4UWOplyIp22Q7W87o6G7X0TwkGLvIPP83qfcIuiUuyuQdTWH0R2LozFlfgj/7DBeALBINcLussWNDcewpGearQ0Fcu1xM+aGvfD7epHQ/2zuHJlAa+9uiVth5vLUVt1EB1tFVheGofHPQCfrw8tTWVgW1mxMggotJIPP7wFq6VX2mgluVwQ775zPX/Nu+/cEE/OYe8X74/BbDhYsLwnSjbOTODkZgLxpBXTsxE0t5bCZBlAS6sSZxg4yp0DqKvfj/b2GliMyojv6qyQ9YdrTmLcJYu82dgr5xjfTE87EAxrZa2aTDlkLaEyqQBOiUw78DnaUWXq2ymphAftrZWKhc54MJP1ycBgGz3IL768K8gCrZnvGuhvEljo4ec89qJOX7nlcQQiwwhGjPl/UlXQTunqqEU65cNE3ImZrB/pSU/+Go97WJREl7ulsULOe/1GxOIOUczDcYtmtFMsRD02mvrgcmvlmNY5M+PC7Iwf09MuTE05ZT8/F5J2TqdmczdCQT2slmOyxvm9hb/9iRG7qx/tnUp0Ho46YHMo0f9OqarZB64//N3aonQ8pyZiZhzBAZ9e4JuLF+bx5huXxTUuKymCul50ddehqrJIOnMq48bKckymJPX5tModr8vLl1/dFSukcrhlMg4YDT35ax98fBPTU4UBsmflrbevwWIqBIZ0CrjnGsGRzt+EajiVTYxbkZ0OoLy0CNmpKEaHFUQhNmaUzjx6pAaxqFPad7xil9TWFqO6Yr+08x5OcffvFdYfOgi7buB1mTD83t3Y4GMvs/MK8jwW96K4tAg2x6gcd3Y34nBbFQ63KSP7/fffEItQ76uroSOgrEN0Ci5dXJHOT6WsMtLZoUy6EZFeW02C+JnJeAzxMbu45apTQQmHnf/bTv3mm/s40lMpjgKPVZzOqO9FVYWCLnDtYYqCCARR8Yef8dgK451E2oZYwiJQjlbfi5KyZ6HRHYdG9wI6upSpr7z8eVSWPY+66pL8P89Y58L5OfHaGLdQKVwj1C077YPHNYqWJqVDKTeubyKZNCGT3g0b/ZQEfYXOJv6WSbtliiTSwFQEFf/xZxfgdh8Xr5DKaj9ch9Lin7bOx0qCYasEo4x5Hm5bPzkLl7eQyVRxNVUIWt66uYGuzlLMztmRzSqWk826RUGZtAvj8QLq7XUZ8fLt0zi3lZVz8zOJfNvrv7jyyPtVJJySnfWCmB3XICqIVqrGYp988oq42ZxiyXOIRgyPPGtPiAqMquJ2avHrX91BSXGReFtiNVk3Zme9mJsNyHSjXqsb7YXDNoKtrUlcv7Yi5+tqCnmg4gNFIBjaUKtYaGdrLYJhHeoalKnw5bsrEqyKs5BRBgAHA93zjfWETK1UDFEHJv3ee/fm46+k5fVxJNIOGC3HJDBVzzs8uyNyogU7jxvqDkpwyPWktqYIzNlQQXnlzHng8fThh796gJbmg3j7rcvS+Uu5JL799j7+6V8e4De/fQN//eOf4vSpSQFUX3/tnKxVO9/D56q/N04lxHpolaqFUkFEItjO9zNVvvP+x1645iQzTgyMtEhaQT2v0XchPe2FxzuK5aUY1tcSSCacEoxy7s9kbBJwck3oaC+BTtuJ0pIilNFryzoxlQ4hEtbLos11auc721pLMDraIqmErq5iLC76MD/vF8BVvcbjU6ao+rrn5L38zUFx+VIOiYQRr762hu9/eBtnt8bQ1Pi8OA+trTXo7FSU9UTI3//D91g5GUI8aRQHQWfqzv9zVNiR49VYXZ/A9Wurcp5OAGOekeFWdHaUoKe7SihSHM3Hjlbh7Nn0rs6hsqg8NbI/0l0vSiRa7fYcwdS0GdGIPg+AMqba6XaXlBWhvKwI1ZVKEE0F1VTtUxRXq6TPVWloUBJ5T5x89OnLSGc9mM2FMKLtQFdPA3LLMczmAghGNXC4+rC2OoERTTtW1mKIxowyhXFqWVmJSlaUJBACoOozP/34XVy9Oot79zdRfFDpcFoTF+9I2ChKIizDfA49LgKpaq6Hx/G4QVINvJ7pBp6nJTIQ5m+j/gQ626slmNbtyE3pdH0oflI8N1XKt0fnTklnXQjFhuH09kJn6BYg0+k2wO4axuJyRIFeZhnVW3H16jwSCbOsDcTJqDxCOUePVEkn01HglEiohh3P9WN+LijZ0M6OcsRjZsHSqCyZEi09OH06LvfZrArtanjosFgu8T0eMzXBPZOKLa1KuqGxWUE29rwMDjdhdtYNk6kNNttRaDTNSKXMkjyLRrVYWAjkMbOlxSjGx42yqVAMvS+iDLmFiCzoO72806fS0sYckZpH0o72YDEXEUXymMg18bem+jJ0tTc+VUrjduSuysycT9Yc1Yu6cWNJPDZaDhVBV1dQ5xkP0pNOCUjpNBBLkyB2W1GcGok807p4LFBO1ifBLn/T6SAcxKQg71/MReW6U6diWMpNoL6mWGIgxj1W+3H0D7VgVFPA5yw2Btmd0Oq7YLGeQFXVPtTVleS3mppDshFOUrkSJvNxWKz90BteQHOzYpkm04DgjwRwLdZBMNXClD83k/nfxoeoqNiH0tJnwYCfFDQe87zHq0drWyWYed51w2tvncHcol8YOyvrCZhtygsTKTsmknYEQlqZinSaI4IIcKNlqArKTntx//4lsSjGJ1QOSSBsW16OiNJ4fm7Oh7l5B4zGdgwONOFwcwkmJ21YXQvIGsZ3Utlk7dDCqFjieVQgKx84fdKTpLI2Nyfz/wSvm5qyi0fJ50Wjo+LJOV0jYFC7uBJAMm3B7Lxf/h+3dwhu7yAmMy7Ex7f/P8cAsjMhxCcsmEiZhI0U2SaysAPHYlakMz6MJ6yIxvRYWIwgM+1BKm1HctIhG6/VaBV+RCiiR2xCD69/EHrDUYQiOmEwkSTjD44iHDUgOmaR5/I9gaAZtbUKIzcSNYODRP3/ipIZxa0e1bfB5R1Cc6sSEEbjw1heHcPV64r3Rk+Kna/VtogC2BnstA9/fUcBRbOKgu7dexE9PaXY2sqI28x7zp+flk69eWsB4+NaUTDjokzGgtbDxZie8qOnu0KmyYkJk+R67Lbjony+m2nuhQUPrl1dEfd6/WQBHlpdDWFl1YfVNT+WlwOYm3NJG9fJuUUncise5FZcWFjyYGU9iEzWgkzWhqVVP1Y3IpjLeXBqM4b1UxHZ1k6GsXEmgqU1H7w+DYpLimTNnc9FkEhZMTsfxPSsC/OLfrmXg4CK5TsDoRFwdgmEB+R93GbmXbLN5ahgM5bX+KwgFhZDss0venHl+gJKSotE8b7AKC5dXiso6PrtBWRmnGhu24fF1UKQmpjUIznpxObZWVjNfYJvcaRzkb9+XZnSOF0RE+Mo5u+lpaBYjN8/CHLc6Aiwk9nOKYuWYTEfFeeClkTHYn4ugnDIgKHBZqTTVlEQFc/76Ezwb6HTQG/w7NY4cjk/vvpGQQfoBVJxi8tWXLg4gVfuLOHUGZ+0ffz5S3jwxSW8/vYSHnx+Rbaz5xP4j7//AFdemsJnX93C19/dwo9/fw/ffPcKfvPDG/jyP9zFd9+/jT//y1/g9t15GeGdXbVY2fBhataClQ0PpmYNyM7ZsXkhjIVlN+YWrcgtKwPmjXsn8cGfXcCPf/drvP/BZfz2d+/hu+/v4/OvX8Ev3l6T/d/94wf47OuX8Fc/3sNf/u5N/PXfvo/ffP8nAlB/+uVt/Ot/fYD/9j/+oqAgMnays3Fk5z1YOxPEsKZdGmm+5FGTJqVeS6LH8tKY5HA4pVFJtBx2JNPenGroIEjHz/vziMLCfEjWFl5HBZ8+E4XD0SPrF2Og3EIYen0LUikjgsFhURAVOhY1QDPaLu471y+bvQP19UVY2yig3qfPjGFzKyiB7sUXU7h+IyNtHMnL637MLDAz7EB6yikzwpVrK7h0eUOmwFfungWnlKHhdgRCGhndueUgVjdCWFmPIj3lQUdnDVbXUjLS53IuscLpWRsWlp1YXgvItnoyiFFNFwzG48JaOnkqi2s3FvDpF3fwyed3cfPlZdkmJyMwmwdx8vQkzl+cx8VLufz/wRCG+61z8zizNY71k6mCkn6ONNYpiygpURzddJm5X1qMSzaVnT87E5BzSkqbDoJLFMZr1Wwo3ea1tZg4Bkxh19fuw3jMgcMtzJoq93Cq5HNYO8R3Dg22yGCg4poan8Pp00mcPz8pvAa2G7SFhJ/DWYjFKI99TPSP//w7cQ7iE164/X3whws41plzY9CbFM1SOtqqxKsi7sZ4RU3WUWhVDEDJbyOHgOcYjJKBw+mRkA4xNbJ8aIlEDpj4I4QTDppw986mTKEkj3DdouXRm6OTwMwp29bXJuDxDUOnPwKXexg+vxK01lQWCJZPnDDwHJtQvChyEAJhhedWVl6E1dUIxsY0eWjFbOyX2GRtdVxSBeS4tbcy0LTmUQQqQQUruddrj+bvr63eD73mRJ4QT3zu4vkVWYNu3c5hMq1HOmPE7dvrmEwbMBYbkrjKoO/C0hIt0IZIrJC2UNMQNvMTBo4+LJGYEocwi6rbUXRFFzgUUsgdTAPEx5zQjHSDvDZ6clz8F+bDQvV1bWdgWRFHRICExJs3NuRcKuHL42ulh4oeqUTgGsU1jM/js0kAIeGEFknEQlU+Kx5Iyi8rewZNTQpq0NPZiM62Jwgc/bnCNLKy8O9OQ5MmxX1TvdJB6nT2X/7T7zGdCUrFtlpYVVNdhMZtfjeDTu4JepLpw98sG+Ge6xLdZ65XVBKdDLraJCrOzQZBS6mqeHbX30HQdecxRUUV1LKUPSW0DEItXEPee+8qAgFlAWe6mUg1pzNSp8hXaKw/IGg1LWvzzJQy0rexM1Zu5xbGYHd0oKddIXyQRSpOxqxXaoXonnNPjjczsawG31ifRFdHlRAUuTYxKceKByqSnDpWhat/K+lghb/8CZGllWkkUiGpdHu47Q+Jy1MgBtocJzCRtEhEHY6YkEo70XOkBn2DSkfNLYTR3VOLd+69jIb650WJAX+hGqG5uVzA1bfefFG8OFpOV2cZ/L4RcQ7oapNOrEyvGlEeBwsVxI10Xz7n5VtbuHo1h7GxEXHnjabdFRiPnWRmrTBbdy+wDpdCFvy58vpb5+V6xg5Lq2FsXchIhK7RduPb7+5LUXF2Vqn65lrBHBArv9WaIFWYSjAZe8Rl57pGl511QgxcExMOIZ3wOpbr0+1WA2eyWEmSZBszsgatsmZGNf2IRwsOxWMp0ws2dHQVingJ19v1WlQcULwuVTKZiICLucVHOdovvbwkgKGqIEIa84tuqei+dkOpCWLAxz1TFhNJJfD95ps3ZV9RtR/19cWSsj53bgpjUbPAPMwvEXkgt5vXsTqP+8ryInz11ZsIBPqktogpd5/HgK72eszPjgnqwevCHg3oNe78Wx87mZkPQWc8Cod7BM5tmu1PyaGSIgRjBVTBF1Dm/Hvv3gDTD7SahSUf7r93Hqe2AmhpPYhoXBn1hES4pycXiyuj/du/eDX/rLYOxaubyvgQG7MI8kBuwvi4XpwUuuFcu7jn+kP3n2kO3kMXnw4Nf7O6gS45lUpL69kx+B5L+c3v7uPshQxiSY1w4f7kV3flH9IbB8SyOLofvqehqVzaVBpWZ08NHK5e9BytxGzOhs3zUZzeCuP8i5Ow2o8JJP/O++dRVvwM3v/lTQFHed9nXyjsUFZRuNyjwmtgfojnJlNuLC2O5VlBaysKek23XaX+CqNnyisOh5rEo7Dc8ssv7sHtPoE/5Ok98dLSViYWt/PcV9+8J7iVPzQoYOEvPzgniK3aTpyrtfU5fPjRNTnndWuwuqJw4egIkFy4sOCT5B55DuRuMz1BD+1wywE0N5agslxxs0lYIUhKBdIFZ7kkz3/y6S3B9XSaYyg5+AwYHxX+wj0kB4uLEI7aUV17ANG4FcMaJb55573rWNtIIBQ2IjZuFJCwtb1YrIvt8/NugXb48Qoeq9w6Kovxz69+dV1cd05dnMYYg9HFHo/bpITl0osLkpOSZ83GJXhloo7H9AoJtHLtovPAKY77XX/4XpDNLeU7CPzgxIFtgsd4ygabozf/CZidUlldhD/98CYqtksnWV6SnHBj84yCOFdXPi9OAX+3tynwD1Pd2amQ8L2Z6mZqOxLWSYqCuZ5s1i6FyYSYaC10Dhj3BAOjcj2fQXbpTgLLEycsHn74HKWtowaBiBbpaT8uX1uBxz8ixVwGU49UbvO7CcxWjieN+Q8mUZgiVn+vLE/AbuuVajwGtDzHjqZ7zViHaQmuU6xxZdzDRCHzREw3zM+TDOnDzIwDd+4oMBIRbRJP5D264/kSyideUhkvwlEXqmr2wx80w74Dxt/cWpTp7fyledTVHxRsTG1r2XYCdgpJ7Nx7XFrcvnUGne1Krj/g16K9TbmeSDkpwEe6a+UrIzsLge+/syX5HuagJL+04MEbb5yVski2s4i4sb5YislYm/TElZ78IVk/68X0vBNW5wtw+4bh8Wsk68c2Vts5PYMIjg3gcNshjCcV2P/nCNcRrhGctoyGbly+nMXI8GGsroznK/QIpjKGITzETiesMzxcB5JFqKQ7d9aEOMkaV16v1+7I4e8VYdzDqS6W1GHtZApdRyqFu802fgqM7rZGX2DQ0HnY9YCHpLZ6n7BDr1xekvWC2VLGNWzrbKtD547KOhUYZaqCfAe61MzO1tUVCc9Odav/5sfPBf2mJ6giDXtK6AisnoyBaw8rv8nfJgN1VNcpnxGjkoijRcbNCMWMqKhSCJA//u3XkgBkvmhl1SMEEmJkH310G0ZjZz7aV4X8Nm4DA/XiNjMFzqSdFGFFRiTDymzsl1+9ChYrq/eNjijl+FQQN341a+dz94yQVMIvjlBBPOYnYbSGI2hpKdQJ1dSXwOoYxK8fvCo5/rq6Q+Jhqe0c4ckJLxrq9oPoNc+R4sugk+g1jxeXPJLaForWnE+43mbTEXEQyCL65NPb+eeRu6AUavVKvStTFurH//akXLu5JtZDZfG7PSq5ZDqhkAlVoTdHZODq9RVcvJATatXbb1+UigQizLyGZZO5RZaNOMR9ZlKO52/fXhXuHN1pMoQ8nl5cvDAne/X5Kg+hquK57aruF2SaU6fLPS2r69MIx4ewsBxEa4dSSfA///t/3tUxFv3uz7Dwe6WnN6cQi9uEeG+2KutY/1ANsnNuZOecsjndA5hIGZCeNgt3LT1tF36ZPHPbdaa3GAhYhOGp0Ra+G/fi5QI75qls43Hc233HULK97uw8/1PCOiP19wcfvoTZBa8oh7Qokvf4kUByzoiCk4e2814yMsnQdLj6BSknaWRn+1P5PxQWU5ELxt8c9ezckdFuvHL3NLS6o/jkszfx/Q9/hi+/eUsKrw4zptnmSZN3QBpvU3MptPwIk29I+GdUNBVGzvTD73sqPyG5qTQMw48SyakMMjSTKSXlQN7yqLZA5fpDwm+hcq/VH9/1MQ1+HZgxWTCih8W2B93q/1uZThXgnZ1CFmVdQ5Fwm23OIfhCo+g6WoGS8iJx1VMZP4KRQv0r3XjuDaaCO06Xf2klDd/2N32eyr+D8Jt0iUmv1MWy9HJUp6DVX3z9Ltx+ZfoiV4+W8/C9T+XfQX77wwOEogZYHMcxkXLlrYOpd5Zeun1apKeUJN5T+SMJ65LOXczh9Xun8OBThafwVBT5X4F4dcYTkplHAAAAAElFTkSuQmCC',
  };
  const TANK_IMAGES = {};
  (function loadTankImages() {
    // TANK_SVG 内为完整 data URI（PNG 贴图），直接作为图片源加载
    for (const k of Object.keys(TANK_SVG)) {
      const img = new Image();
      img.onload = () => { TANK_IMAGES[k] = img; };
      img.src = TANK_SVG[k];
    }
  })();

  function drawTank(p, now) {
    const t = p.render;
    const color = p.color;
    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(t.x, t.y + 5, 26, 20, t.a, 0, Math.PI * 2); ctx.fill();
    // 车体贴图（SVG 精细绘制；未加载完成前用简易色块兜底）
    const trackOk = !t.prt || t.prt[0];
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.a);
    const bodyImg = t.ty === 'ru' ? TANK_IMAGES.ruBody : TANK_IMAGES.usBody;
    if (bodyImg) {
      // 车体铺满碰撞盒 52x44（大小与原版一致，像素画拉伸可接受）
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bodyImg, -26, -22, 52, 44);
    } else {
      ctx.fillStyle = color;
      rr(-25, -13, 50, 26, 6); ctx.fill();
      ctx.fillStyle = '#1b222f';
      rr(-27, -17, 54, 11, 4); ctx.fill();
      rr(-27, 6, 54, 11, 4); ctx.fill();
    }
    // 履带损坏标记（断裂 + 冒烟点）
    if (!trackOk) {
      ctx.strokeStyle = '#5a4633';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(-16, -13); ctx.lineTo(4, -13); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2, 10); ctx.lineTo(20, 10); ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.arc(-6, -13, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(12, 10, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // 炮塔贴图（损坏时炮管歪斜）+ 炮管（长度与子弹出生点一致）
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.ta + (t.prt && !t.prt[1] ? 0.5 : 0));
    const turImg = t.ty === 'ru' ? TANK_IMAGES.ruTurret : TANK_IMAGES.usTurret;
    if (turImg) {
      // 炮塔贴图自带炮管（真实比例，宽 52 对齐）
      const s = 0.5;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(turImg, -turImg.width * s / 2, -turImg.height * s / 2, turImg.width * s, turImg.height * s);
    } else {
      ctx.fillStyle = t.ty === 'ru' ? '#4a5a48' : '#46524a';
      ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
      // 炮管（与服务器子弹出生点 34 一致；回退样式）
      ctx.fillStyle = '#232c38';
      rr(6, -3.2, 30, 6.4, 3); ctx.fill();
      ctx.fillStyle = '#3a4656';
      rr(14, -3.9, 20, 7.8, 3.5); ctx.fill(); // 热护套
      ctx.fillStyle = '#d8dee9';
      ctx.fillRect(33, -2, 5, 4);             // 炮口制退器
    }
    ctx.restore();
    // 玩家标识色环（炮塔基座，保留个人颜色识别）
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(t.x, t.y, t.ty === 'ru' ? 6 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // 护盾
    if (t.shd) {
      const pulse = 0.65 + Math.sin(now / 160) * 0.2;
      ctx.strokeStyle = 'rgba(77, 208, 225, ' + pulse + ')';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(t.x, t.y, 30, 0, Math.PI * 2); ctx.stroke();
    }
    // 发动机损坏：车尾冒烟
    if (t.prt && !t.prt[2] && Math.random() < 0.25) {
      particles.push({
        x: t.x - Math.cos(t.a) * 24, y: t.y - Math.sin(t.a) * 24,
        vx: -Math.cos(t.a) * 40 + (Math.random() - 0.5) * 30,
        vy: -Math.sin(t.a) * 40 + (Math.random() - 0.5) * 30,
        life: 0.8, maxLife: 0.8, size: 4 + Math.random() * 4, color: '#555566',
      });
    }
    // 起火：车体火焰
    if (t.fr > 0 && Math.random() < 0.6) {
      particles.push({
        x: t.x + (Math.random() - 0.5) * 30, y: t.y + (Math.random() - 0.5) * 30,
        vx: (Math.random() - 0.5) * 40, vy: -60 - Math.random() * 40,
        life: 0.5, maxLife: 0.5, size: 6 + Math.random() * 6, color: Math.random() < 0.5 ? '#ff7043' : '#ffd54f',
      });
    }
    // 血条 & 名字（观瞄损坏时无法识别敌方坦克名字）
    const bw = 46;
    const hpFrac = clamp(t.hp / 100, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    rr(t.x - bw / 2 - 1, t.y - 40, bw + 2, 7, 3); ctx.fill();
    ctx.fillStyle = hpFrac > 0.5 ? '#66bb6a' : hpFrac > 0.25 ? '#ffca28' : '#ff5d5d';
    rr(t.x - bw / 2, t.y - 39, bw * hpFrac, 5, 2.5); ctx.fill();
    if (p.id === myId || selfParts.optics) {
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = p.id === myId ? '#fff' : 'rgba(220,230,250,0.9)';
      ctx.fillText(p.name, t.x, t.y - 46);
    }
  }

  // 触屏摇杆绘制（屏幕坐标）
  function drawJoysticks() {
    if (!touch.mode) return;
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    const draw = (j, label) => {
      if (!j) return;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath(); ctx.arc(j.sx, j.sy, JOY_R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(j.sx, j.sy, JOY_R, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(79,195,247,0.4)';
      ctx.beginPath(); ctx.arc(j.sx + j.dx, j.sy + j.dy, 26, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(79,195,247,0.8)';
      ctx.beginPath(); ctx.arc(j.sx + j.dx, j.sy + j.dy, 26, 0, Math.PI * 2); ctx.stroke();
      if (label) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(label, j.sx, j.sy - JOY_R - 10);
      }
    };
    draw(touch.aim, '瞄准');
    if (!touch.aim) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath(); ctx.arc(vw - 95, vh - 105, 40, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🎯 瞄准开火', vw - 95, vh - 100);
    }
  }

  function drawMinimap(s) {
    const plist = (s && s.players) || [];
    const blist = (s && s.bullets) || [];
    const pulist = (s && s.pups) || [];
    mmCtx.clearRect(0, 0, mm.width, mm.height);
    mmCtx.fillStyle = 'rgba(13, 18, 32, 0.9)';
    mmCtx.fillRect(0, 0, mm.width, mm.height);
    const sx = mm.width / WORLD.w, sy = mm.height / WORLD.h;
    mmCtx.fillStyle = '#1c2740';
    for (const o of mapObstacles) mmCtx.fillRect(o.x * sx, o.y * sy, o.w * sx, o.h * sy);
    mmCtx.strokeStyle = '#2c3e60';
    mmCtx.lineWidth = 2;
    mmCtx.strokeRect(1, 1, mm.width - 2, mm.height - 2);
    for (const b of blist) {
      mmCtx.fillStyle = '#ffd54f';
      mmCtx.fillRect(b.x * sx - 1, b.y * sy - 1, 2, 2);
    }
    for (const p of plist) {
      if (p.x == null) continue;
      if (p.id === myId) {
        mmCtx.fillStyle = '#ffffff';
        mmCtx.beginPath();
        mmCtx.arc(p.x * sx, p.y * sy, p.alive ? 3 : 2, 0, Math.PI * 2);
        mmCtx.fill();
      } else if (selfParts.optics) {
        mmCtx.fillStyle = (players.get(p.id) || {}).color || '#888';
        mmCtx.beginPath();
        mmCtx.arc(p.x * sx, p.y * sy, p.alive ? 3 : 2, 0, Math.PI * 2);
        mmCtx.fill();
      } else {
        // 观瞄损坏：不显示敌人具体位置，只显示忽明忽暗的模糊光点（闪烁 + 轻微抖动）
        const t = performance.now() / 1000;
        const blink = 0.2 + 0.4 * (0.5 + 0.5 * Math.sin(t * 3 + (p.id || '').length * 7));
        const jx = Math.sin(t * 5 + (p.id || '').length * 7) * 18;
        const jy = Math.cos(t * 4 + (p.id || '').length * 3) * 18;
        mmCtx.globalAlpha = blink;
        mmCtx.fillStyle = (players.get(p.id) || {}).color || '#888';
        mmCtx.beginPath();
        mmCtx.arc((p.x + jx) * sx, (p.y + jy) * sy, p.alive ? 3 : 2, 0, Math.PI * 2);
        mmCtx.fill();
      }
    }
    mmCtx.globalAlpha = 1;
    for (const pu of pulist) {
      mmCtx.fillStyle = PUP_COLOR[pu.type] || '#fff';
      mmCtx.beginPath(); mmCtx.arc(pu.x * sx, pu.y * sy, 2.5, 0, Math.PI * 2); mmCtx.fill();
    }
  }

  // ---------------- HUD ----------------
  function updateHUD() {
    els.hpBar.innerHTML = '<i style="width:' + Math.round(clamp(selfHp / 100, 0, 1) * 100) + '%"></i>';
    els.hpText.textContent = Math.max(0, Math.round(selfHp)) + '/100';
    // 部件状态显示
    els.partTrack.classList.toggle('ok', selfParts.track);
    els.partTurret.classList.toggle('ok', selfParts.turret);
    els.partEngine.classList.toggle('ok', selfParts.engine);
    els.partAmmo.classList.toggle('ok', selfParts.ammo);
    els.partOptics.classList.toggle('ok', selfParts.optics);
    // 维修进度
    if (selfRepair > 0) {
      els.repairBar.classList.remove('hidden');
      els.repairBar.firstChild.style.width = Math.min(100, Math.round(selfRepair / 2.5 * 100)) + '%';
    } else {
      els.repairBar.classList.add('hidden');
    }
    // 弹药显示（单发装填）
    if (localReload > 0) {
      els.ammoBox.textContent = '装填中 ' + Math.ceil(localReload) + 's';
      els.ammoBox.classList.add('reloading');
    } else {
      els.ammoBox.textContent = '🔫 已装填';
      els.ammoBox.classList.remove('reloading');
    }
    // 反应装甲显示（血条制：命中扣 伤害/2，扣完失效）
    const eraMax = (TANK_TYPES[selfType] && TANK_TYPES[selfType].eraMax) || 200;
    if (selfEra > 0) {
      const pct = Math.max(0, Math.min(100, Math.round(selfEra / eraMax * 100)));
      els.eraBox.textContent = '🛡️ 爆反 ' + pct + '%';
      els.eraBox.classList.remove('no-era');
    } else {
      els.eraBox.textContent = '🛡️ 爆反耗尽';
      els.eraBox.classList.add('no-era');
    }
    els.buffs.innerHTML = '';
    if (selfBuffs.shd) addBuff('护盾', 'b-shield', selfBuffs.shd);
    if (selfBuffs.rap) addBuff('速射', 'b-rapid', selfBuffs.rap);
    if (selfBuffs.trp) addBuff('三连', 'b-triple', selfBuffs.trp);
    els.pingText.textContent = ping >= 0 ? ping : '-';
    // 记分板
    const latest = snaps[snaps.length - 1];
    if (latest) {
      const rows = latest.players.slice().sort((a, b) => (b.wins - a.wins) || (b.kills - a.kills));
      els.sbRows.innerHTML = '';
      for (const r of rows) {
        const div = document.createElement('div');
        div.className = 'sbrow' + (r.id === myId ? ' me' : '');
        div.innerHTML = '<span><span class="dot" style="background:' + ((players.get(r.id) || {}).color || '#888') + ';display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>' + esc(r.name) + '</span><span>' + r.kills + '杀 · ' + r.wins + '胜</span>';
        els.sbRows.appendChild(div);
      }
    }
    // 死亡提示
    const multi = snaps.length > 0 && snaps[snaps.length - 1].players.length > 1;
    if (phase === 'play' && myId && !selfAlive && multi) {
      els.deathText.textContent = '💥 你被击毁了，下回合继续';
      show(els.deathOverlay, true);
    } else if (phase === 'play' && myId && !selfAlive) {
      els.deathText.textContent = '💥 被击毁，即将重生…';
      show(els.deathOverlay, true);
    } else {
      show(els.deathOverlay, false);
    }
  }
  function addBuff(label, cls, secs) {
    const d = document.createElement('div');
    d.className = 'buff ' + cls;
    d.textContent = label + ' ' + secs + 's';
    els.buffs.appendChild(d);
  }

  // ---------------- 界面流程 ----------------
  function showMenu() {
    show(els.menu, true);
    show(els.lobby, false);
    show(els.hud, false);
    show(els.topbar, false);
    show(els.scoreboard, false);
    show(els.deathOverlay, false);
    show(els.banner, false);
    show(els.countdown, false);
    els.killfeed.innerHTML = '';
    phase = 'lobby';
    myId = null;
    roomCode = null;
    joined = false;
    browse = false;
    gameShown = false;
    stopBrowse();
    snaps = [];
    players.clear();
    pred = null;
    ensureBrowse();
  }
  function showLobby() {
    show(els.menu, false);
    show(els.lobby, true);
    show(els.hud, false);
    show(els.topbar, true);
    show(els.scoreboard, false);
    els.codeText.textContent = roomCode;
    els.lobbyCode.textContent = roomCode;
    els.lobbyLink.textContent = '好友加入：http://' + location.host + '/?room=' + roomCode;
    renderLobby([]);
  }
  function showGame() {
    show(els.menu, false);
    show(els.lobby, false);
    show(els.hud, true);
    show(els.topbar, true);
    show(els.scoreboard, true);
    els.codeText.textContent = roomCode;
    gameShown = true;
  }
  function renderLobby(list) {
    if (!list) return;
    els.playerList.innerHTML = '';
    for (const p of list) {
      const div = document.createElement('div');
      div.className = 'plrow' + (p.host ? ' host' : '');
      const color = PALETTE[hashId(p.id) % PALETTE.length];
      const tIcon = p.type === 'ru' ? '🇷🇺' : '🇺🇸';
      div.innerHTML = '<span class="dot" style="background:' + color + '"></span>' + tIcon + ' ' +
        esc(p.name) + (p.host ? ' <span class="crown">👑</span>' : '') +
        (p.id === myId ? ' <span style="color:#4fc3f7;font-size:11px">(你)</span>' : '') +
        (p.alive ? '' : ' <span style="color:#7e92b8;font-size:11px">[观战中]</span>');
      els.playerList.appendChild(div);
    }
    const isHost = hostId === myId;
    show(els.btnStart, isHost);
    els.lobbyHint.textContent = isHost ? '点击开始，人数越多越好玩！' : '等待房主开始游戏…';
    els.lobbyLink.textContent = '好友加入：http://' + location.host + '/?room=' + roomCode;
  }
  function hashId(id) {
    let h = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function toggleMute() {
    muted = !muted;
    localStorage.setItem('tk_muted', muted ? '1' : '0');
    els.btnMute.textContent = muted ? '🔇' : '🔊';
  }

  // ---------------- UI 事件绑定 ----------------
  els.nameInput.value = myName;
  els.nameInput.addEventListener('input', () => {
    myName = els.nameInput.value.trim().slice(0, 12);
    localStorage.setItem('tk_name', myName);
  });
  function joinRoom(room, solo) {
    myName = els.nameInput.value.trim().slice(0, 12) || ('玩家' + Math.floor(100 + Math.random() * 900));
    localStorage.setItem('tk_name', myName);
    els.errMsg.textContent = '';
    if (ws && ws.readyState === 1) {
      if (!joined) {
        // 从浏览连接转为加入意图：发送 join，并确保断线后按加入重连
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } // 清掉浏览重连定时器，避免竞态
        intent = { join: true, room: room || null, solo: !!solo };
        browse = false;
        stopBrowse();
        ws.send(JSON.stringify({ t: 'join', name: myName, room: room || null, resume: myId, solo: !!solo }));
      }
    } else if (ws && ws.readyState === 0) {
      // 连接建立中：把加入请求挂到连接上，onopen 时发送（避免浏览重连竞态覆盖意图）
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      intent = { join: true, room: room || null, solo: !!solo };
      ws.__pendingJoin = room || null;
      ws.__pendingSolo = !!solo;
    } else {
      connect(room, { solo });
    }
  }
  els.btnCreate.addEventListener('click', () => joinRoom(null));
  els.btnSolo.addEventListener('click', () => joinRoom(null, true));
  els.btnJoin.addEventListener('click', () => {
    const code = els.joinInput.value.trim().toUpperCase();
    if (!code) { els.errMsg.textContent = '请输入房间号'; return; }
    joinRoom(code);
  });
  els.btnRefresh.addEventListener('click', () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'list' }));
  });
  els.joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.btnJoin.click(); });
  els.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.btnCreate.click(); });
  els.btnStart.addEventListener('click', () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'start' }));
  });
  // 选坦克（大厅）
  function pickTank(type) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'pick', type }));
    els.tpUs.classList.toggle('sel-us', type === 'us');
    els.tpRu.classList.toggle('sel-ru', type === 'ru');
  }
  els.tpUs.addEventListener('click', () => pickTank('us'));
  els.tpRu.addEventListener('click', () => pickTank('ru'));
  function leaveRoom() {
    intentionalClose = true;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'leave' }));
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    ws = null;
    showMenu();
  }
  els.btnBack.addEventListener('click', leaveRoom);
  els.btnLeave.addEventListener('click', leaveRoom);
  els.btnConnCancel.addEventListener('click', () => {
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    ws = null;
    show(els.connOverlay, false);
    showMenu();
  });

  // 复制链接
  function copyText(text, btn, doneLabel) {
    const done = () => {
      if (btn) {
        const old = btn.textContent;
        btn.textContent = '✓ 已复制';
        setTimeout(() => { btn.textContent = old; }, 1500);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    done();
  }
  els.btnCopy.addEventListener('click', () => {
    copyText(location.origin + '/?room=' + roomCode, els.btnCopy);
  });
  els.btnPub.addEventListener('click', () => {
    if (tunnelUrl) copyText(tunnelUrl + '/?room=' + roomCode, els.btnPub);
  });
  els.btnMute.textContent = muted ? '🔇' : '🔊';
  els.btnMute.addEventListener('click', toggleMute);

  // 公网通道
  els.btnTunnel.addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'tunnel', action: tunnelState === 'on' ? 'stop' : 'start' }));
    }
  });
  function updateTunnelUI() {
    show(els.btnPub, tunnelState === 'on' && !!tunnelUrl);
    if (!joined) return;
    els.tunnelStatus.innerHTML = '';
    if (tunnelState === 'on' && tunnelUrl) {
      const link = tunnelUrl + '/?room=' + roomCode;
      const txt = document.createElement('div');
      txt.className = 'pubLink';
      txt.textContent = '公网链接（好友可直接打开）：';
      const a = document.createElement('a');
      a.textContent = link;
      a.href = link;
      a.target = '_blank';
      const cp = document.createElement('button');
      cp.className = 'mini';
      cp.textContent = '复制';
      cp.onclick = () => copyText(link, cp);
      els.tunnelStatus.appendChild(txt);
      els.tunnelStatus.appendChild(a);
      els.tunnelStatus.appendChild(cp);
      els.btnTunnel.textContent = '关闭公网联机';
      els.btnTunnel.disabled = false;
    } else if (tunnelState === 'starting') {
      els.tunnelStatus.textContent = '正在建立公网通道…（首次使用需自动下载组件约 50MB，请稍候）';
      els.btnTunnel.textContent = '建立中…';
      els.btnTunnel.disabled = true;
    } else if (tunnelState === 'error') {
      els.tunnelStatus.textContent = '公网通道建立失败：' + (tunnelError || '未知错误') + '。可手动下载 cloudflared.exe 放入服务器 bin 目录后重试；或改用 Tailscale / 端口转发（见 README）。';
      els.btnTunnel.textContent = '🌐 开启公网联机';
      els.btnTunnel.disabled = false;
    } else {
      els.tunnelStatus.textContent = '开启后生成公网链接，好友无需同一网络即可加入（首次自动下载组件）。';
      els.btnTunnel.textContent = '🌐 开启公网联机';
      els.btnTunnel.disabled = false;
    }
  }

  // 局域网房间列表
  function renderRoomList() {
    if (!rooms.length) {
      els.roomList.innerHTML = '<p class="empty">暂无房间，创建或加入一个吧</p>';
      return;
    }
    els.roomList.innerHTML = '';
    const phaseLabel = { lobby: '大厅', countdown: '准备中', play: '战斗中', over: '结算中' };
    for (const r of rooms) {
      const div = document.createElement('div');
      div.className = 'rrow';
      div.innerHTML = '<b>' + esc(r.code) + '</b> <span class="rn">' + esc(r.host || '?') + '</span> <span class="rc">' + r.players + '/' + r.max + '</span> <span class="rp">' + (phaseLabel[r.phase] || r.phase) + '</span>';
      div.onclick = () => joinRoom(r.code);
      els.roomList.appendChild(div);
    }
  }

  // 触屏加速键
  els.boostBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); touch.boost = true; });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => {
    els.boostBtn.addEventListener(ev, () => { touch.boost = false; });
  });
  // 触屏模式标记 + 竖屏提示
  if (touch.mode) document.body.classList.add('touch');
  const pmq = window.matchMedia('(orientation: portrait)');
  const applyPortrait = () => document.body.classList.toggle('portrait', touch.mode && pmq.matches);
  if (pmq.addEventListener) pmq.addEventListener('change', applyPortrait);
  else pmq.addListener(applyPortrait);
  applyPortrait();

  // 从 URL 预填房间号
  (() => {
    const params = new URLSearchParams(location.search);
    const code = (params.get('room') || '').toUpperCase().trim();
    if (code) { els.joinInput.value = code; els.nameInput.focus(); }
  })();

  window.addEventListener('beforeunload', () => {
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
  });

  // ---------------- 主循环 ----------------
  function resize() {
    // 每帧自检：尺寸不符（CSS 加载时机/窗口变化/缩放）时立即重建缓冲
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor((canvas.clientWidth || window.innerWidth) * dpr);
    const h = Math.floor((canvas.clientHeight || window.innerHeight) * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  window.addEventListener('resize', resize);

  function update(now, dt) {
    // 僵尸连接检测：7 秒无 pong 说明连接已被服务器丢弃（TCP 假活），强制断开重连
    if (ws && performance.now() - lastPongAt > 7000) {
      const deadWs = ws;
      try { deadWs.close(); } catch (e) { /* ignore */ }
      setTimeout(() => {
        if (ws === deadWs) {
          ws = null;
          if (intent.join) connect(intent.room, { browse: false });
          else ensureBrowse();
        }
      }, 600);
    }
    // 输入发送 / 本地预测
    resize();
    sendInput(now);
    // 弹药本地模拟（单发制：开火后进入装填，服务器快照校正）
    localFireCd -= dt;
    if (localReload > 0) {
      localReload -= dt;
      if (localReload <= 0) localMag = MAG_SIZE;
    }
    const inpNow = currentInput();
    if (phase === 'play' && selfAlive && selfParts.turret && inpNow.shoot && localFireCd <= 0 && localMag > 0) {
      localFireCd = 0.25;
      localMag = 0;
      let reload = TANK_TYPES[selfType].reload;
      if (selfType === 'ru' && !selfParts.loader) reload *= 2; // 俄军装弹机损坏；美军无装弹机
      if (selfBuffs.rap > 0) reload *= 0.5;
      localReload = reload;
      // 本地子弹预测：立即显示自己发射的子弹（不等服务器往返），穿深与服务器一致
      if (pred) {
        const ta = autoTurret ? pred.a : mouseAngle;
        const spd = 620;
        const tt = TANK_TYPES[selfType] || TANK_TYPES.us;
        predBullets.push({
          x: pred.x + Math.cos(ta) * 34, y: pred.y + Math.sin(ta) * 34,
          vx: Math.cos(ta) * spd, vy: Math.sin(ta) * spd,
          pen: tt.pen, t: performance.now(),
        });
        if (selfBuffs.trp > 0) {
          predBullets.push({ x: pred.x + Math.cos(ta - 0.18) * 34, y: pred.y + Math.sin(ta - 0.18) * 34, vx: Math.cos(ta - 0.18) * spd, vy: Math.sin(ta - 0.18) * spd, pen: tt.pen, t: performance.now() });
          predBullets.push({ x: pred.x + Math.cos(ta + 0.18) * 34, y: pred.y + Math.sin(ta + 0.18) * 34, vx: Math.cos(ta + 0.18) * spd, vy: Math.sin(ta + 0.18) * spd, pen: tt.pen, t: performance.now() });
        }
      }
    }
    // 推进/清理本地预测子弹（反弹几何与服务器一致：线段检测 + 穿深衰减，1.2 秒后服务器快照接管）
    const penDrop = (TANK_TYPES[selfType] || TANK_TYPES.us).penDrop || 100;
    for (let i = predBullets.length - 1; i >= 0; i--) {
      const pb = predBullets[i];
      const px0 = pb.x, py0 = pb.y;
      pb.x += pb.vx * dt;
      pb.y += pb.vy * dt;
      // 命中检测：敌方坦克 + 自己（反弹回来的炮弹会自伤，与服务器一致；players 里含自己）
      let hitTank = false;
      for (const p of players.values()) {
        if (!p.render) continue;
        const r = p.render;
        const dx = r.x - pb.x, dy = r.y - pb.y;
        const fwx = Math.cos(r.a), fwy = Math.sin(r.a);
        const lx = dx * fwx + dy * fwy;
        const ly = -dx * fwy + dy * fwx;
        if (Math.abs(lx) < TANK.l / 2 + 6 && Math.abs(ly) < TANK.w / 2 + 6) {
          hitTank = true;
          spawnParticles(pb.x, pb.y, '#ff8a65', 6, 2.2);
          break;
        }
      }
      if (hitTank) { predBullets.splice(i, 1); continue; }
      // 世界墙反弹（与服务器同：反弹扣穿深，扣完消失）
      let bounced = false;
      if (pb.x < WALL_T + 5) { pb.x = WALL_T + 5; pb.vx = -pb.vx; bounced = true; }
      else if (pb.x > WORLD.w - WALL_T - 5) { pb.x = WORLD.w - WALL_T - 5; pb.vx = -pb.vx; bounced = true; }
      if (!bounced && pb.y < WALL_T + 5) { pb.y = WALL_T + 5; pb.vy = -pb.vy; bounced = true; }
      else if (!bounced && pb.y > WORLD.h - WALL_T - 5) { pb.y = WORLD.h - WALL_T - 5; pb.vy = -pb.vy; bounced = true; }
      // 障碍反弹：线段检测（与服务器 segRectHit 一致，反弹轨迹完整）
      if (!bounced) {
        for (const o of mapObstacles) {
          const hit = segRectHit(px0, py0, pb.x, pb.y, o);
          if (hit) {
            pb.x = hit.x; pb.y = hit.y;
            const vn = pb.vx * hit.nx + pb.vy * hit.ny;
            if (vn < 0) {
              pb.vx -= 2 * vn * hit.nx;
              pb.vy -= 2 * vn * hit.ny;
              bounced = true;
            }
            break;
          }
        }
      }
      if (bounced) {
        pb.pen -= penDrop;
        if (pb.pen <= 0) { predBullets.splice(i, 1); continue; }
      }
      // 兜底：子弹中心进入障碍内部（反弹后贴墙/擦角）→ 按最近表面推出（与服务器一致，杜绝穿墙）
      if (!bounced) {
        for (const o of mapObstacles) {
          if (pb.x > o.x && pb.x < o.x + o.w && pb.y > o.y && pb.y < o.y + o.h) {
            const dl = pb.x - o.x, dr = o.x + o.w - pb.x;
            const dt = pb.y - o.y, db = o.y + o.h - pb.y;
            const min = Math.min(dl, dr, dt, db);
            let nx = 0, ny = 0;
            if (min === dl) { pb.x = o.x - 5; nx = -1; }
            else if (min === dr) { pb.x = o.x + o.w + 5; nx = 1; }
            else if (min === dt) { pb.y = o.y - 5; ny = -1; }
            else { pb.y = o.y + o.h + 5; ny = 1; }
            const vn = pb.vx * nx + pb.vy * ny;
            if (vn < 0) {
              pb.vx -= 2 * vn * nx;
              pb.vy -= 2 * vn * ny;
              pb.pen -= penDrop;
              if (pb.pen <= 0) { predBullets.splice(i, 1); continue; }
            }
            break;
          }
        }
      }
      // 寿命与服务器一致（5.5s）：反弹中的炮弹必须渲染完整，不能过早消失
      if (performance.now() - pb.t > 5500) predBullets.splice(i, 1);
    }
    sendPing(now);
    stepPred(dt);

    // 鼠标世界角度
    if (mouse.active) {
      autoTurret = false;
      const wx = cam.x + (mouse.x - canvas.clientWidth / 2) / cam.s;
      const wy = cam.y + (mouse.y - canvas.clientHeight / 2) / cam.s;
      mouseAngle = Math.atan2(wy - (pred ? pred.y : cam.y), wx - (pred ? pred.x : cam.x));
    }

    // 快照插值
    const st = interpState(now);
    const sa = st.a;
    bullets = sa ? sa.bullets : [];
    pups = sa ? sa.pups : [];
    const selfPos = (pred && selfAlive && phase === 'play') ? pred : null;

    // 更新渲染玩家
    const seen = new Set();
    for (const p of players.values()) {
      const pa = sa ? snapshotPlayer(sa, p.id) : null;
      const pb = st.b ? snapshotPlayer(st.b, p.id) : null;
      const src = pb || pa;
      if (!src || src.x == null || !src.alive) { p.render = null; continue; }
      seen.add(p.id);
      if (p.id === myId && selfPos) {
        p.render = { x: selfPos.x, y: selfPos.y, a: selfPos.a, ta: autoTurret ? selfPos.a : mouseAngle, hp: selfHp, shd: selfBuffs.shd, ty: selfType, prt: [selfParts.track, selfParts.turret, selfParts.engine, selfParts.ammo, selfParts.optics, selfParts.loader], fr: selfFire };
      } else {
        const from = pa || src;
        const to = pb || src;
        const f = st.b ? st.f : 0;
        p.render = {
          x: lerp(from.x, to.x, f),
          y: lerp(from.y, to.y, f),
          a: angLerp(from.a, to.a, f),
          ta: angLerp(from.ta, to.ta, f),
          hp: to.hp,
          shd: to.shd,
          prt: to.prt || [true, true, true, true, true, true],
          fr: to.fr || 0,
          ty: to.ty || 'us',
        };
      }
    }
    // 新玩家
    if (sa) {
      for (const sp of sa.players) {
        if (!players.has(sp.id)) {
          players.set(sp.id, {
            id: sp.id,
            name: sp.name,
            color: PALETTE[hashId(sp.id) % PALETTE.length],
            render: null,
          });
        }
      }
    }
    // 移除的玩家
    for (const id of [...players.keys()]) {
      if (sa && !sa.players.some((sp) => sp.id === id)) players.delete(id);
    }

    // 相机与绘制
    updateCam(dt, selfPos);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.translate(vw / 2, vh / 2);
    ctx.scale(cam.s, cam.s);
    ctx.translate(-cam.x, -cam.y);
    drawWorld(st, now);
    ctx.restore();
    drawJoysticks();
    // 小地图：观瞄部件损坏时不可用（战术惩罚）
    // 小地图始终显示；观瞄损坏时敌人位置改为忽明忽暗的模糊光点（内部处理）
    drawMinimap(sa);

    // 粒子更新
    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i];
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= 0.96;
      pt.vy *= 0.96;
      pt.life -= dt;
      if (pt.life <= 0) particles.splice(i, 1);
    }

    // HUD 低频更新
    hudTimer += dt;
    if (hudTimer > 0.15) {
      hudTimer = 0;
      updateHUD();
    }
  }

  let lastNow = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;
    update(now, dt);
    requestAnimationFrame(loop);
  }

  // ---------------- 朝向自动测试模式（?facing=1，仅供自动化验证渲染朝向） ----------------
  if (new URLSearchParams(location.search).has('facing')) {
    const sleepF = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      const reportStage = (s) => {
        try { fetch('http://127.0.0.1:8125/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: s }) }); } catch (e) { /* ignore */ }
      };
      try {
        const report = { redN: 0, redLx: 0, yellowN: 0, yellowLx: 0, deckF: 0, deckB: 0, a: 0, ta: 0, x: 0, y: 0, vw: 0, vh: 0, dpr: 1, camS: 0, phase: '', ty: '', err: '' };
        reportStage('boot');
        // 等待菜单就绪
        for (let i = 0; i < 100 && !window.__gameBooted; i++) await sleepF(100);
        reportStage('menu');
        const els2 = { name: document.getElementById('nameInput'), create: document.getElementById('btnCreate'), start: document.getElementById('btnStart'), lobby: document.getElementById('lobby') };
        els2.name.value = '朝向测试';
        els2.create.click();
        for (let i = 0; i < 80 && els2.lobby.classList.contains('hidden'); i++) await sleepF(100);
        reportStage('lobby');
        els2.start.click();
        // 等待进入战斗
        for (let i = 0; i < 200 && (phase !== 'play' || !pred); i++) await sleepF(100);
        reportStage('play:' + phase + ' pred=' + (pred ? 1 : 0));
        await sleepF(2500); // 相机/插值稳定
        // 按 W 直走 1.5 秒
        keys.KeyW = true;
        await sleepF(1500);
        keys.KeyW = false;
        await sleepF(400);
        // 采样像素：整屏 ImageData
        const dpr2 = Math.min(window.devicePixelRatio || 1, 2);
        const vw2 = canvas.clientWidth, vh2 = canvas.clientHeight;
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const ca = Math.cos(pred.a), sa = Math.sin(pred.a);
        let redN = 0, redSx = 0, yellowN = 0, yellowSx = 0, deckF = 0, deckB = 0;
        for (let ly = -22; ly <= 22; ly += 1) {
          for (let lx = -26; lx <= 26; lx += 1) {
            const d2 = lx * lx + ly * ly;
            if (d2 < 64) continue; // 避开中央炮塔基座/色环
            const wx = pred.x + lx * ca - ly * sa;
            const wy = pred.y + lx * sa + ly * ca;
            const sx = Math.round(((wx - cam.x) * cam.s + vw2 / 2) * dpr2);
            const sy = Math.round(((wy - cam.y) * cam.s + vh2 / 2) * dpr2);
            if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) continue;
            const o = (sy * canvas.width + sx) * 4;
            const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
            if (Math.abs(r - 201) <= 35 && Math.abs(g - 106) <= 35 && Math.abs(b - 90) <= 35) { redN++; redSx += lx; }
            else if (Math.abs(r - 216) <= 35 && Math.abs(g - 199) <= 35 && Math.abs(b - 122) <= 35) { yellowN++; yellowSx += lx; }
            else if (lx > 8 && Math.abs(r - 141) <= 30 && Math.abs(g - 125) <= 30 && Math.abs(b - 82) <= 30) deckF++;
            else if (lx < -8 && Math.abs(r - 141) <= 30 && Math.abs(g - 125) <= 30 && Math.abs(b - 82) <= 30) deckB++;
          }
        }
        // 打印红块预期位置的实际颜色（调试）
        const debugCols = [];
        for (const [dlx, dly] of [[23.9, 3.1], [23.9, -3.1], [24.4, 4.2], [-23.9, 3.1]]) {
          const dwx = pred.x + dlx * ca - dly * sa;
          const dwy = pred.y + dlx * sa + dly * ca;
          const dsx = Math.round(((dwx - cam.x) * cam.s + vw2 / 2) * dpr2);
          const dsy = Math.round(((dwy - cam.y) * cam.s + vh2 / 2) * dpr2);
          if (dsx >= 0 && dsy >= 0 && dsx < canvas.width && dsy < canvas.height) {
            const o = (dsy * canvas.width + dsx) * 4;
            debugCols.push([dlx, dly, img.data[o], img.data[o + 1], img.data[o + 2]]);
          }
        }
        report.debugCols = debugCols;
        report.redN = redN; report.redLx = redN ? +(redSx / redN).toFixed(1) : 0;
        report.yellowN = yellowN; report.yellowLx = yellowN ? +(yellowSx / yellowN).toFixed(1) : 0;
        report.deckF = deckF; report.deckB = deckB;
        // 迷雾验证：坦克周围 8 方向 260px 采样，视野外应为迷雾暗色（r<9）；视野内（扇形）应可见
        let fogDark = 0, fogSector = 0;
        const fAng = autoTurret ? pred.a : mouseAngle;
        const fogPts = [];
        for (let k = 0; k < 8; k++) {
          const a8 = k * Math.PI / 4;
          const wx8 = pred.x + Math.cos(a8) * 260, wy8 = pred.y + Math.sin(a8) * 260;
          // 跳过世界边界外的采样点（迷雾只覆盖世界区域）
          if (wx8 < 0 || wy8 < 0 || wx8 > WORLD.w || wy8 > WORLD.h) { fogPts.push([k, Math.round(wx8), Math.round(wy8), 'off']); continue; }
          const sx8 = Math.round(((wx8 - cam.x) * cam.s + vw2 / 2) * dpr2);
          const sy8 = Math.round(((wy8 - cam.y) * cam.s + vh2 / 2) * dpr2);
          if (sx8 < 0 || sy8 < 0 || sx8 >= canvas.width || sy8 >= canvas.height) { fogPts.push([k, Math.round(wx8), Math.round(wy8), 'off']); continue; }
          const o8 = (sy8 * canvas.width + sx8) * 4;
          const r8 = img.data[o8], g8 = img.data[o8 + 1], b8 = img.data[o8 + 2];
          let dAng = a8 - fAng;
          while (dAng > Math.PI) dAng -= Math.PI * 2;
          while (dAng < -Math.PI) dAng += Math.PI * 2;
          const inSector = Math.abs(dAng) <= Math.PI / 6 + 0.001;
          fogPts.push([k, Math.round(wx8), Math.round(wy8), r8 + ',' + g8 + ',' + b8, inSector ? 'sector' : 'out']);
          if (inSector) { if (r8 > 9) fogSector++; }
          else if (r8 < 9) fogDark++;
        }
        report.fogDark = fogDark; report.fogSector = fogSector; report.fogPts = fogPts;
        report.a = +pred.a.toFixed(3); report.ta = +pred.ta.toFixed(3);
        report.x = Math.round(pred.x); report.y = Math.round(pred.y);
        report.vw = vw2; report.vh = vh2; report.dpr = dpr2; report.camS = +cam.s.toFixed(3);
        report.phase = phase; report.ty = selfType || '';
        report.shot = canvas.toDataURL('image/png').split(',')[1];
        try {
          await fetch('http://127.0.0.1:8125/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
          reportStage('done');
        } catch (e) { console.log('FACING report POST 失败: ' + e.message); }
      } catch (e) {
        reportStage('error:' + e.message);
        console.log('FACING 异常: ' + e.message);
      }
    })();
  }

  // ---------------- 反弹渲染测试模式（?bounce=1：朝左墙开火，验证反弹炮弹渲染完整） ----------------
  if (new URLSearchParams(location.search).has('bounce')) {
    const sleepB = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      const stg = (s) => {
        try { fetch('http://127.0.0.1:8125/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: s }) }); } catch (e) { /* ignore */ }
      };
      const report = { bullets: 0, bounces: 0, xs: [], err: '' };
      try {
        stg('boot');
        for (let i = 0; i < 100 && !window.__gameBooted; i++) await sleepB(100);
        stg('menu');
        const el = { name: document.getElementById('nameInput'), create: document.getElementById('btnCreate'), start: document.getElementById('btnStart'), lobby: document.getElementById('lobby') };
        el.name.value = '反弹测试';
        el.create.click();
        for (let i = 0; i < 80 && el.lobby.classList.contains('hidden'); i++) await sleepB(100);
        stg('lobby');
        el.start.click();
        for (let i = 0; i < 200 && (phase !== 'play' || !pred); i++) await sleepB(100);
        stg('play:' + phase);
        await sleepB(2000);
        // 朝右上斜射（自伤功能下反弹炮弹不能原路返回打到自己）：撞上墙反弹后朝右下远离坦克
        autoTurret = false;
        mouseAngle = -Math.PI / 4;
        await sleepB(200);
        keys.Space = true;
        await sleepB(150);
        keys.Space = false;
        // 等 3.5 秒（旧逻辑 1.2s 后本地子弹已被删除，主视角将无子弹渲染）
        await sleepB(3500);
        report.bullets = predBullets.length;
        report.xs = predBullets.map((p) => Math.round(p.x)).slice(0, 30);
        // 反弹次数：vx 方向翻转次数
        let bounces = 0, prevV = 0;
        for (const p of predBullets) {
          const v = Math.sign(p.vx);
          if (v !== 0 && prevV !== 0 && v !== prevV) bounces++;
          prevV = v;
        }
        report.bounces = bounces;
      } catch (e) { report.err = e.message; stg('error:' + e.message); }
      try {
        await fetch('http://127.0.0.1:8125/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
        stg('done');
      } catch (e) { console.log('BOUNCE report POST 失败: ' + e.message); }
    })();
  }

  // ---------------- 启动 ----------------
  showMenu();
  resize();
  requestAnimationFrame(loop);
  window.__gameBooted = true; // boot 完成标记（测试/调试用）
})();
