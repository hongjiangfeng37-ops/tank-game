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
  const TANK = { rx: 26, ry: 22, l: 52, w: 44, maxSpeed: 240, accel: 340, back: 0.62, turn: 3.2, dragF: 0.9, dragL: 3.8, hp: 100, boostMult: 1.3 };
  const MAG_SIZE = 1;       // 弹匣容量：单发装填（与 server.js 一致）
  const TANK_TYPES = {      // 客户端展示用（与 server.js 一致）
    us: { name: '美军 M1A1标题党', reload: 4, eraMax: 300, pen: 800, penDrop: 100, armor: '600/200/400', armorEra: '900/800/400', color: '#6b8e5a' },
    ru: { name: '俄军 T90A', reload: 6, eraMax: 500, pen: 800, penDrop: 200, armor: '800/300/700', armorEra: '1200/1100/700', color: '#5f7a52' },
    jp: { name: '日军 90式主战坦克', reload: 3, eraMax: 200, pen: 500, penGain: 200, penBounceMax: 9, armor: '550/150/250', armorEra: '800/400/500', color: '#7a6a4a' },
    il: { name: '以军 梅卡瓦Mk4', reload: 4.5, eraMax: 200, pen: 550, penDrop: 100, armor: '600+200机/250+200机/450+200机', armorEra: '850+200机/800+200机/450+200机', color: '#8a9a6a', mortar: true },
    cn: { name: '中国 99B主战坦克', reload: 5, eraMax: 400, pen: 900, penDrop: 50, armor: '1000/150/650', armorEra: '1450/600/1100', color: '#c9b27c', aps: true },
    de: { name: '欧盟 豹二A7主战坦克', reload: 5, eraMax: 300, pen: 800, penDrop: 0, penBounceMax: 2, armor: '600/200/400', armorEra: '900/800/400', color: '#7a8a5a', fireCtrl: true },
    hj10: { name: '中国 红箭10导弹车', reload: 15, eraMax: 0, pen: 2000, penDrop: 0, mag: 2, armor: '200/200/200', armorEra: '200/200/200', color: '#c9b27c', instaKill: true, noBounce: true, hjSpeed: 900 },
  };
  const PALETTE = ['#ff5d5d', '#4fc3f7', '#66bb6a', '#ffee58', '#ff8a65', '#ba68c8', '#4dd0e1', '#f06292', '#aed581', '#90a4ae'];
  const PUP_COLOR = { health: '#4caf50', shield: '#4dd0e1', rapid: '#ffca28', triple: '#ff7043', atgm: '#ff7043' };
  const PUP_ICON = { health: '回血', shield: '护盾', rapid: '速射', triple: '三连', atgm: '导弹' };
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
    hud: $('hud'), hpBar: $('hpBar'), hpText: $('hpText'), ammoBox: $('ammoBox'), eraBox: $('eraBox'), buffs: $('buffs'), wepBox: $('wepBox'), wepText: $('wepText'), wepBar: $('wepBar'),
    tpUs: $('tp-us'), tpRu: $('tp-ru'), tpJp: $('tp-jp'), tpIl: $('tp-il'), tpCn: $('tp-cn'), tpDe: $('tp-de'), tpHj: $('tp-hj'),
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
  let selfAmFire = 0;           // 弹药架起火标记（更剧烈特效）
  let selfMortar = 0;           // 梅卡瓦迫击炮冷却剩余秒（0=就绪）
  let selfAg = 0;               // 反坦克导弹持有数
  let selfJm = 0;               // 自己被窗帘干扰
  let selfShtoraCd = 0;         // T90A 干扰冷却剩余（20s 满=可用）
  let localHjSide = 0;          // 红箭10 左右发射架交替标记
  let mortarLocalLock = 0;      // 手机/键盘按住开火的本地迫击炮锁（防重复发送）
  const bulletRenders = new Map(); // 快照子弹插值状态（id → {x,y,tx,ty,...}）消除 30Hz 跳帧
  let mortarMode = false;       // 梅卡瓦当前火炮模式：false=主炮 true=迫击炮
  let selfApsN = 0;             // 99B 主动防御充能
  let selfApsOn = 0;            // 主动防御激活剩余秒
  let selfApsCd = 0;            // 主动防御冷却剩余秒
  let selfRadarT = 0;           // 火控雷达激活剩余秒（豹二A7）
  let selfRadarCd = 0;          // 火控雷达冷却剩余秒
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
      case 'kick': {
        // 被房主移出房间
        intentionalClose = true;
        if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
        ws = null;
        leaveRoom();
        showMenu();
        els.errMsg.textContent = '你已被房主移出房间';
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
    if (me.mag != null) localMag = me.mag; // 弹匣同步（服务器权威；红箭10 两连发开局 2 发）
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
      selfAmFire = me.am || 0;
      selfMortar = me.mc || 0;   // 迫击炮冷却剩余秒（30s 满=就绪）
      selfAg = me.ag || 0;       // 反坦克导弹
      selfJm = me.jm || 0;       // 被窗帘干扰
      selfShtoraCd = me.sj || 0; // T90A 干扰冷却剩余（20s 满=可用）
      selfApsN = me.ap || 0;     // 主动防御充能
      selfApsOn = me.apo || 0;   // 主动防御激活剩余
      selfApsCd = me.apc || 0;   // 主动防御冷却剩余
      selfRadarT = me.rt || 0;   // 火控雷达激活剩余
      selfRadarCd = me.rc || 0;  // 火控雷达冷却剩余
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
          if (e.id === myId && e.type === 'atgm') showDamageNote('🎯 拾取强化攻击！下一发开火自动发射', true);
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
          if (e.id === myId) showDamageNote(e.am ? '💥 弹药架起火了！持续掉血' : '🔥 起火了！持续掉血', false);
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
        case 'mshot':
          // 迫击炮发射：炮口闪光
          spawnParticles(e.x, e.y, '#ff7043', 10, 3.5);
          if (e.id === myId) showDamageNote('💣 迫击炮发射！30s 冷却', true);
          break;
        case 'mboom':
          spawnParticles(e.x, e.y, '#ff8a65', 22, 4);
          spawnParticles(e.x, e.y, '#3a3a3a', 12, 3.5);
          sfx.boom();
          break;
        case 'mhit':
          if (e.id === myId) showDamageNote('💥 被迫击炮命中！爆反 -30%', false);
          break;
        case 'jam':
          // 干扰闪光特效（蓝白电弧爆发——导弹被干扰掉头的瞬间）
          spawnParticles(e.x, e.y, '#8a6bff', 14, 4.5);
          spawnParticles(e.x, e.y, '#bfe8ff', 10, 3);
          if (e.id === myId) showDamageNote('📡 导弹被干扰，原路返回！', false);
          break;
        case 'atgm':
          if (e.id === myId) showDamageNote('🚀 反坦克导弹发射！', true);
          break;
        case 'aps':
          if (e.id === myId) {
            if (e.on) showDamageNote('🛡️ 主动防御开启！抵挡一次攻击（10秒）', true);
            else if (e.n === 2) showDamageNote('🛡️ 主动防御已充能（2次）', true);
          }
          break;
        case 'apsblock':
          if (e.id === myId) showDamageNote('🛡️ 主动防御抵挡了攻击！', true);
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
    // 梅卡瓦：1/2 切换主炮/迫击炮
    if (e.code === 'Digit1' && selfType === 'il') { mortarMode = false; showDamageNote('🔫 主炮模式', true); }
    if (e.code === 'Digit2' && selfType === 'il') { mortarMode = true; showDamageNote('💣 迫击炮模式（穿墙直射，30s 一发）', true); }
    // B 键：强化攻击提示（捡到后下一发自动强化，无需按键）
    if (e.code === 'KeyB' && selfAg > 0) {
      showDamageNote('🚀 强化攻击已就绪！下一发开火自动发射', true);
    }
    // E 键：99B 主动防御 / 豹二A7 火控雷达
    if (e.code === 'KeyE' && selfType === 'cn' && ws && ws.readyState === 1 && phase === 'play') {
      ws.send(JSON.stringify({ t: 'aps' }));
    }
    if (e.code === 'KeyE' && selfType === 'de' && ws && ws.readyState === 1 && phase === 'play') {
      ws.send(JSON.stringify({ t: 'radar' }));
    }
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

  // 手机端：梅卡瓦迫击炮切换键 + 反坦克导弹键
  const mortarBtn = document.getElementById('btnMortarMode');
  if (mortarBtn) {
    mortarBtn.addEventListener('click', () => {
      mortarMode = !mortarMode;
      mortarBtn.classList.toggle('on', mortarMode);
      showDamageNote(mortarMode ? '💣 迫击炮模式（穿墙直射，30s 一发）' : '🔫 主炮模式', true);
    });
  }
  const atgmBtn = document.getElementById('btnAtgm');
  if (atgmBtn) {
    atgmBtn.addEventListener('click', () => {
      if (selfAg > 0) showDamageNote('🚀 强化攻击就绪！下一发开火自动发射', true);
    });
  }
  const apsBtn = document.getElementById('btnAps');
  if (apsBtn) {
    apsBtn.addEventListener('click', () => {
      if (selfType === 'cn' && ws && ws.readyState === 1 && phase === 'play') ws.send(JSON.stringify({ t: 'aps' }));
    });
  }
  const radarBtn = document.getElementById('btnRadar');
  if (radarBtn) {
    radarBtn.addEventListener('click', () => {
      if (selfType === 'de' && ws && ws.readyState === 1 && phase === 'play') ws.send(JSON.stringify({ t: 'radar' }));
    });
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
    // 梅卡瓦迫击炮：本地锁 + 服务器冷却双重限制，按住手机开火也只发一发
    if (mortarMode && inp.shoot) {
      if (selfMortar <= 0 && mortarLocalLock <= 0) {
        ws.send(JSON.stringify({ t: 'mfire' }));
        mortarLocalLock = 30;
      }
      inp.shoot = false;
    }
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
    const wR = Math.hypot(TANK.rx, TANK.ry);
    const minX = WALL_T + wR, maxX = WORLD.w - WALL_T - wR;
    const minY = WALL_T + wR, maxY = WORLD.h - WALL_T - wR;
    if (tk.x < minX) { tk.x = minX; if (tk.vx < 0) tk.vx = -tk.vx * 0.3; }
    else if (tk.x > maxX) { tk.x = maxX; if (tk.vx > 0) tk.vx = -tk.vx * 0.3; }
    if (tk.y < minY) { tk.y = minY; if (tk.vy < 0) tk.vy = -tk.vy * 0.3; }
    else if (tk.y > maxY) { tk.y = maxY; if (tk.vy > 0) tk.vy = -tk.vy * 0.3; }
    // 障碍：旋转矩形（OBB）vs AABB，SAT 精确碰撞（稳定贴墙不抽搐）
    const ca = Math.cos(tk.a), sa = Math.sin(tk.a);
    const tc = [
      [tk.x + ca * TANK.rx - sa * TANK.ry, tk.y + sa * TANK.rx + ca * TANK.ry],
      [tk.x + ca * TANK.rx + sa * TANK.ry, tk.y + sa * TANK.rx - ca * TANK.ry],
      [tk.x - ca * TANK.rx + sa * TANK.ry, tk.y - sa * TANK.rx - ca * TANK.ry],
      [tk.x - ca * TANK.rx - sa * TANK.ry, tk.y - sa * TANK.rx + ca * TANK.ry],
    ];
    for (const o of mapObstacles) {
      // 性能粗筛：AABB 距离预判——障碍不在坦克附近直接跳过 SAT（每帧省 90%+ 计算）
      const ocx = o.x + o.w / 2, ocy = o.y + o.h / 2;
      if (Math.abs(tk.x - ocx) > o.w / 2 + 38 || Math.abs(tk.y - ocy) > o.h / 2 + 38) continue;
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
  // 豹二A7 火控雷达：显示自机炮弹弹道预测线（反弹折线，与服务器反弹一致）
  function drawRadarTrajectory() {
    if (phase !== 'play' || !selfAlive || !pred || selfRadarT <= 0 || selfType !== 'de') return;
    if (!selfParts.turret) return;
    const ta = autoTurret ? pred.a : mouseAngle;
    let x = pred.x + Math.cos(ta) * 34, y = pred.y + Math.sin(ta) * 34;
    let dx = Math.cos(ta), dy = Math.sin(ta);
    ctx.strokeStyle = 'rgba(77, 208, 225, 0.55)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let bounce = 0; bounce < 3; bounce++) {
      let bounced = false;
      for (let s = 0; s < 34; s++) { // 每段最多 ~540px
        const px = x, py = y;
        x += dx * 16; y += dy * 16;
        // 世界墙反射
        if (x < WALL_T || x > WORLD.w - WALL_T || y < WALL_T || y > WORLD.h - WALL_T) {
          if (x < WALL_T) { x = WALL_T; dx = -dx; } else if (x > WORLD.w - WALL_T) { x = WORLD.w - WALL_T; dx = -dx; }
          if (y < WALL_T) { y = WALL_T; dy = -dy; } else if (y > WORLD.h - WALL_T) { y = WORLD.h - WALL_T; dy = -dy; }
          bounced = true; break;
        }
        // 障碍反射（用上一帧位置判断进入方向）
        let hitOb = false;
        for (const o of mapObstacles) {
          if (x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h) {
            if (px <= o.x) dx = -Math.abs(dx); else if (px >= o.x + o.w) dx = Math.abs(dx);
            if (py <= o.y) dy = -Math.abs(dy); else if (py >= o.y + o.h) dy = Math.abs(dy);
            hitOb = true; break;
          }
        }
        if (hitOb) { bounced = true; break; }
      }
      ctx.lineTo(x, y);
      if (!bounced) break;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(77, 208, 225, 0.75)';
    ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
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
    // 障碍（视口裁剪：只画屏幕内障碍，每帧省大量 fillRect）
    const vpx0 = cam.x - canvas.clientWidth / 2 / cam.s - 60;
    const vpx1 = cam.x + canvas.clientWidth / 2 / cam.s + 60;
    const vpy0 = cam.y - canvas.clientHeight / 2 / cam.s - 60;
    const vpy1 = cam.y + canvas.clientHeight / 2 / cam.s + 60;
    for (const o of mapObstacles) {
      if (o.x > vpx1 || o.x + o.w < vpx0 || o.y > vpy1 || o.y + o.h < vpy0) continue;
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
    // 子弹：服务器快照权威渲染（含自机炮弹，解决"发射不显示/消失"）；本地预测弹仅作快照到达前的即时反馈
    // 子弹插值推进（渲染位置向目标收敛，消除 30Hz 跳帧）
    for (const rs of bulletRenders.values()) {
      rs.x += (rs.tx - rs.x) * 0.4;
      rs.y += (rs.ty - rs.y) * 0.4;
      rs.vx = rs.tvx; rs.vy = rs.tvy;
    }
    let hasOwnServerBullet = false;
    for (const b of bullets) {
      const rs = bulletRenders.get(b.i);
      if (rs) { b.x = rs.x; b.y = rs.y; b.vx = rs.vx; b.vy = rs.vy; } // 用插值位置渲染
      if (b.o === myId) hasOwnServerBullet = true;
      if (b.r) {
        // 被窗帘干扰返回：蓝紫色电子干扰拖尾 + 闪烁（明显返回动画）
        const pulse = 0.6 + Math.sin(now / 55) * 0.4;
        const tx = b.x - b.vx * 0.16, ty = b.y - b.vy * 0.16;
        ctx.strokeStyle = 'rgba(150, 110, 255, ' + pulse + ')';
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = 'rgba(120, 200, 255, ' + pulse * 0.5 + ')';
        ctx.lineWidth = 9;
        ctx.beginPath(); ctx.moveTo(b.x - b.vx * 0.09, b.y - b.vy * 0.09); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.fillStyle = '#efe6ff';
        ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(170, 120, 255, 0.55)';
        ctx.beginPath(); ctx.arc(b.x, b.y, 11, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (b.hj) {
        // 红箭10 反坦克导弹：超长拖尾 + 亮色弹头 + 尾焰
        const tx = b.x - b.vx * 0.16, ty = b.y - b.vy * 0.16;
        ctx.strokeStyle = 'rgba(255, 90, 40, 0.85)';
        ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 180, 90, 0.35)';
        ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(b.x - b.vx * 0.08, b.y - b.vy * 0.08); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.fillStyle = '#ffd9a0';
        ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255, 160, 70, 0.5)';
        ctx.beginPath(); ctx.arc(b.x, b.y, 10, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (b.ag) {
        // 强化导弹（ATGM）：与红箭10 同级的长拖尾 + 尾焰
        const tx = b.x - b.vx * 0.16, ty = b.y - b.vy * 0.16;
        ctx.strokeStyle = 'rgba(255, 120, 60, 0.85)';
        ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 200, 110, 0.35)';
        ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(b.x - b.vx * 0.08, b.y - b.vy * 0.08); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.fillStyle = '#ffd9a0';
        ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255, 160, 70, 0.5)';
        ctx.beginPath(); ctx.arc(b.x, b.y, 10, 0, Math.PI * 2); ctx.fill();
        continue;
      }
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
      if (hasOwnServerBullet) break; // 服务器快照已接管自机炮弹，预测弹不再画（避免双弹）
      if (pb.isHj) {
        // 红箭10 预测弹：超长拖尾
        const tx = pb.x - pb.vx * 0.16, ty = pb.y - pb.vy * 0.16;
        ctx.strokeStyle = 'rgba(255, 90, 40, 0.85)';
        ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        ctx.fillStyle = '#ffd9a0';
        ctx.beginPath(); ctx.arc(pb.x, pb.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255, 160, 70, 0.5)';
        ctx.beginPath(); ctx.arc(pb.x, pb.y, 10, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      if (pb.isAtgm) {
        // 强化导弹预测弹：与红箭10 同级长拖尾
        const tx = pb.x - pb.vx * 0.16, ty = pb.y - pb.vy * 0.16;
        ctx.strokeStyle = 'rgba(255, 120, 60, 0.85)';
        ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 200, 110, 0.35)';
        ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(pb.x - pb.vx * 0.08, pb.y - pb.vy * 0.08); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        ctx.fillStyle = '#ffd9a0';
        ctx.beginPath(); ctx.arc(pb.x, pb.y, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255, 160, 70, 0.5)';
        ctx.beginPath(); ctx.arc(pb.x, pb.y, 10, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      const tx = pb.x - pb.vx * 0.045, ty = pb.y - pb.vy * 0.045;
      ctx.strokeStyle = 'rgba(255, 235, 170, 0.7)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.fillStyle = '#fffbe8';
      ctx.beginPath(); ctx.arc(pb.x, pb.y, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255, 220, 130, 0.45)';
      ctx.beginPath(); ctx.arc(pb.x, pb.y, 8, 0, Math.PI * 2); ctx.fill();
    }
    // 豹二A7 火控雷达弹道预测线（画在坦克下层，突出可见）
    drawRadarTrajectory();
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
    // 手机端按钮显隐（梅卡瓦切炮键 / 导弹键 / 99B APS 键）
    if (touch.mode) {
      const mb = document.getElementById('btnMortarMode');
      if (mb) mb.classList.toggle('show', selfType === 'il');
      const ab = document.getElementById('btnAtgm');
      if (ab) ab.classList.toggle('show', selfAg > 0);
      const pb = document.getElementById('btnAps');
      if (pb) {
        pb.classList.toggle('show', selfType === 'cn');
        pb.classList.toggle('on', selfApsOn > 0);
      }
      const rb = document.getElementById('btnRadar');
      if (rb) {
        rb.classList.toggle('show', selfType === 'de');
        rb.classList.toggle('on', selfRadarT > 0);
      }
    }
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

    // ---------------- 坦克贴图（手绘 SVG，车头朝右；车体方正、细节集中在炮塔） ----------------
  const TANK_SVG = {
    // 美军车体：四方主体 + 露出的前楔形车头与尾部格栅（中部被炮塔盖住，从简）
    usBody: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 84">' +
      '<defs><linearGradient id="usbg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#d2bd83"/><stop offset="0.5" stop-color="#c2aa6d"/><stop offset="1" stop-color="#9a8452"/>' +
      '</linearGradient></defs>' +
      // 履带（上下两条）+ 履带齿
      '<rect x="3" y="3" width="94" height="13" rx="6" fill="#151a21"/>' +
      '<rect x="3" y="68" width="94" height="13" rx="6" fill="#151a21"/>' +
      '<line x1="8" y1="9.5" x2="97" y2="9.5" stroke="#0a0d12" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      '<line x1="8" y1="74.5" x2="97" y2="74.5" stroke="#0a0d12" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      // 侧裙板上下缘
      '<rect x="5" y="17" width="90" height="3.5" fill="#3c3527"/>' +
      '<rect x="5" y="63.5" width="90" height="3.5" fill="#3c3527"/>' +
      // 车体主体（四四方方，圆角）
      '<path d="M20,19 L96,19 Q100,19 100,25 L100,59 Q100,65 96,65 L20,65 L12,55 L12,29 L20,19 Z" fill="url(#usbg)" stroke="#3a3524" stroke-width="1.5"/>' +
      // 前部楔形车头（炮塔前方露出部分）
      '<path d="M58,21 L96,21 Q99,21 99,25 L99,59 Q99,63 96,63 L58,63 L44,42 Z" fill="#a9905b" stroke="#3a3524" stroke-width="1"/>' +
      // 尾部引擎格栅（炮塔后方露出部分）
      '<rect x="13" y="25" width="10" height="34" rx="2" fill="#8d7a4b" stroke="#3a3524" stroke-width="0.9"/>' +
      '<line x1="13" y1="31.5" x2="23" y2="31.5" stroke="#5c4f31" stroke-width="0.9"/>' +
      '<line x1="13" y1="38" x2="23" y2="38" stroke="#5c4f31" stroke-width="0.9"/>' +
      '<line x1="13" y1="44.5" x2="23" y2="44.5" stroke="#5c4f31" stroke-width="0.9"/>' +
      '<line x1="13" y1="51" x2="23" y2="51" stroke="#5c4f31" stroke-width="0.9"/>' +
      // 前灯（车头）
      '<circle cx="97.5" cy="27" r="1.8" fill="#ffe9a3" stroke="#3a3524" stroke-width="0.7"/>' +
      '<circle cx="97.5" cy="57" r="1.8" fill="#ffe9a3" stroke="#3a3524" stroke-width="0.7"/>' +
      '</svg>',
    // 美军炮塔：分层结构（菱形主体→储物箱层→双舱盖凸台→舱盖→设备），前尖后平
    usTurret: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 52">' +
      '<defs><linearGradient id="ustg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#dcc98f"/><stop offset="1" stop-color="#b39a5f"/>' +
      '</linearGradient></defs>' +
      // 第1层：菱形主体双分面（中脊分界，上亮下暗）
      '<path d="M55,25 L45,8 L15,5 L5,13 L5,26 L14,26 Z" fill="url(#ustg)" stroke="#3a3524" stroke-width="1.4"/>' +
      '<path d="M55,25 L14,26 L5,26 L5,39 L15,47 L45,44 Z" fill="#8d7d52" stroke="#3a3524" stroke-width="1.4"/>' +
      // 炮盾（前尖炮管根部，两层：暗底座 + 亮面）
      '<path d="M47,16.5 L55,25 L47,33.5 L41.5,25 Z" fill="#6b5d3a" stroke="#3a3524" stroke-width="1"/>' +
      '<path d="M46,18.5 L52,25 L46,31.5 L43,25 Z" fill="#8d7a4b" stroke="#3a3524" stroke-width="0.8"/>' +
      // 第2层：左尾舱储物箱（原斜纹区升级为箱体）
      '<rect x="7.5" y="14.5" width="7" height="23" rx="1.5" fill="#9a8452" stroke="#3a3524" stroke-width="1.1"/>' +
      '<line x1="9" y1="19" x2="13" y2="19" stroke="#5c4f31" stroke-width="1"/>' +
      '<line x1="9" y1="26" x2="13" y2="26" stroke="#5c4f31" stroke-width="1"/>' +
      '<line x1="9" y1="33" x2="13" y2="33" stroke="#5c4f31" stroke-width="1"/>' +
      // 第2层：右侧储物箱（炮盾旁，上分面）
      '<rect x="40.5" y="10.8" width="6.5" height="5.2" rx="1" fill="#8d7a4b" stroke="#3a3524" stroke-width="1"/>' +
      '<line x1="41.8" y1="12.2" x2="45.8" y2="12.2" stroke="#d8c48e" stroke-width="0.9" opacity="0.6"/>' +
      // 第3层：双舱盖凸台（车长右前大、炮手左前小）
      '<circle cx="34" cy="20" r="6" fill="#b39a5f" stroke="#3a3524" stroke-width="1.1"/>' +
      '<circle cx="34" cy="20" r="5.2" fill="none" stroke="#e2d0a0" stroke-width="1" opacity="0.5"/>' +
      '<circle cx="19" cy="19.5" r="4.6" fill="#a08a55" stroke="#3a3524" stroke-width="1"/>' +
      '<circle cx="19" cy="19.5" r="3.8" fill="none" stroke="#e2d0a0" stroke-width="0.9" opacity="0.5"/>' +
      // 第4层：舱盖盖（带把手）
      '<circle cx="34" cy="20" r="4.5" fill="#c8b175" stroke="#3a3524" stroke-width="1.1"/>' +
      '<circle cx="34" cy="20" r="1.5" fill="#6f5f3c"/>' +
      '<line x1="30.5" y1="20" x2="37.5" y2="20" stroke="#3a3524" stroke-width="0.9" opacity="0.75"/>' +
      '<circle cx="19" cy="19.5" r="3.2" fill="#b39a5f" stroke="#3a3524" stroke-width="1"/>' +
      '<circle cx="19" cy="19.5" r="1.1" fill="#6f5f3c"/>' +
      // 第5层：设备（.50 机枪、炮手主镜、车长周视镜、天线）
      '<circle cx="30.5" cy="15.8" r="1.6" fill="#1c1f26" stroke="#3a3524" stroke-width="0.6"/>' +
      '<line x1="30.5" y1="15.8" x2="34.5" y2="13.6" stroke="#1c1f26" stroke-width="1.3"/>' +
      '<rect x="24.5" y="8.5" width="7.5" height="3.6" rx="1" fill="#1c1f26" stroke="#3a3524" stroke-width="0.7"/>' +
      '<rect x="25.8" y="9.3" width="4.8" height="2" rx="0.6" fill="#4a5568"/>' +
      '<circle cx="38.5" cy="16.5" r="2.1" fill="#1c1f26" stroke="#3a3524" stroke-width="0.6"/>' +
      '<circle cx="38.5" cy="16.5" r="0.9" fill="#4a5568"/>' +
      '<line x1="15" y1="8" x2="4" y2="0" stroke="#3a3524" stroke-width="1.1"/>' +
      '</svg>',
    // 俄军 T90A 车体：四方主体 + 外层爆反分层（前后端+侧缘爆反块）+ 两个红点眼睛 + 现代涂色
    ruBody: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 78">' +
      '<defs><linearGradient id="rubg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#5a6a48"/><stop offset="0.5" stop-color="#465438"/><stop offset="1" stop-color="#333f28"/>' +
      '</linearGradient></defs>' +
      // 履带 + 履带齿
      '<rect x="3" y="3" width="94" height="12" rx="6" fill="#10150c"/>' +
      '<rect x="3" y="63" width="94" height="12" rx="6" fill="#10150c"/>' +
      '<line x1="8" y1="9" x2="97" y2="9" stroke="#070a05" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      '<line x1="8" y1="69" x2="97" y2="69" stroke="#070a05" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      // 侧裙板上下缘
      '<rect x="5" y="16" width="90" height="3.5" fill="#2a3526"/>' +
      '<rect x="5" y="58.5" width="90" height="3.5" fill="#2a3526"/>' +
      // 车体主体（四四方方 + 右侧圆角）
      '<path d="M20,17.5 L90,17.5 Q97,17.5 97,23.5 L97,54.5 Q97,60.5 90,60.5 L20,60.5 L12,50.5 L12,27.5 Z" fill="url(#rubg)" stroke="#1c2313" stroke-width="1.5"/>' +
      // 俄军三色迷彩斑（绿底 + 棕 + 黑）
      '<path d="M30,19 L46,19 L42,30 L28,30 Z" fill="#222b18"/>' +
      '<path d="M66,18 L80,18 L78,29 L64,27 Z" fill="#5a4d33"/>' +
      '<path d="M22,34 L38,34 L35,45 L20,44 Z" fill="#4a4433"/>' +
      '<path d="M60,44 L78,44 L76,56 L58,52 Z" fill="#222b18"/>' +
      '<path d="M44,20 L56,20 L54,28 L42,27 Z" fill="#39452b"/>' +
      '<path d="M28,50 L42,50 L40,58 L26,57 Z" fill="#39452b"/>' +
      // 前部弧形铸造首上（T-90 标志：前缘外凸弧面）+ V形导流犁
      '<path d="M54,19 L76,19 Q95,20 98,27 Q99.6,33 99.6,39 Q99.6,45 98,51 Q95,58 76,59 L54,59 L42,39 Z" fill="#4c5a3c" stroke="#1c2313" stroke-width="1"/>' +
      '<path d="M54,19 L76,39 L54,59 Z" fill="none" stroke="#2a3526" stroke-width="1"/>' +
      // 首上爆反：沿弧面 V 形两排（真实 T-90 首上爆反排列）
      '<rect x="62" y="20.5" width="6" height="6" fill="#4d5e35" stroke="#1c2313" stroke-width="0.9"/>' +
      '<rect x="71" y="20.5" width="6" height="6" fill="#4d5e35" stroke="#1c2313" stroke-width="0.9"/>' +
      '<rect x="82" y="24" width="6" height="6" fill="#4d5e35" stroke="#1c2313" stroke-width="0.9"/>' +
      '<rect x="90" y="28" width="6" height="6" fill="#4d5e35" stroke="#1c2313" stroke-width="0.9"/>' +
      '<rect x="90" y="44" width="6" height="6" fill="#4d5e35" stroke="#1c2313" stroke-width="0.9"/>' +
      '<rect x="82" y="48" width="6" height="6" fill="#4d5e35" stroke="#1c2313" stroke-width="0.9"/>' +
      '<rect x="71" y="51.5" width="6" height="6" fill="#4d5e35" stroke="#1c2313" stroke-width="0.9"/>' +
      '<rect x="62" y="51.5" width="6" height="6" fill="#4d5e35" stroke="#1c2313" stroke-width="0.9"/>' +
      // 侧面裙板爆反条（中段）
      '<rect x="34" y="17" width="5" height="46" fill="#4d5e35" stroke="#1c2313" stroke-width="0.9"/>' +
      // 尾部爆反条 + 散热格栅
      '<rect x="14" y="19" width="6" height="40" fill="#4d5e35" stroke="#1c2313" stroke-width="0.9"/>' +
      '<rect x="13" y="23" width="9" height="32" rx="2" fill="#3d4a34" stroke="#1c2313" stroke-width="0.9"/>' +
      '<line x1="13" y1="29.8" x2="22" y2="29.8" stroke="#1c2313" stroke-width="0.9"/>' +
      '<line x1="13" y1="36.6" x2="22" y2="36.6" stroke="#1c2313" stroke-width="0.9"/>' +
      '<line x1="13" y1="43.4" x2="22" y2="43.4" stroke="#1c2313" stroke-width="0.9"/>' +
      '<line x1="13" y1="50.2" x2="22" y2="50.2" stroke="#1c2313" stroke-width="0.9"/>' +
      // 前灯
      '<circle cx="94.5" cy="25" r="1.7" fill="#ffe9a3"/>' +
      '<circle cx="94.5" cy="53" r="1.7" fill="#ffe9a3"/>' +
      '</svg>',
    // 俄军炮塔：分层结构（外圈亮边+边缘环带→满铺爆反层→中心凸台→大舱盖→设备），爆反按圆形裁剪
    ruTurret: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 52">' +
      '<defs>' +
      '<linearGradient id="rutg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#6f8356"/><stop offset="1" stop-color="#44533a"/>' +
      '</linearGradient>' +
      // 爆反块立体渐变（左上亮右下暗，斜向凸起感）
      '<linearGradient id="eraG" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#74894f"/><stop offset="1" stop-color="#394a28"/>' +
      '</linearGradient>' +
      // 舱盖凸台渐变
      '<linearGradient id="hatchG" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#5c6e47"/><stop offset="1" stop-color="#39462a"/>' +
      '</linearGradient>' +
      // 圆形裁剪：边缘爆反被裁成圆弧，贴合圆炮塔轮廓
      '<clipPath id="ruclip"><circle cx="27" cy="26" r="17.6"/></clipPath>' +
      '</defs>' +
      // 第0层：主体大圆 + 外圈亮边（受光边缘）
      '<circle cx="27" cy="26" r="19" fill="url(#rutg)" stroke="#1b2214" stroke-width="1.7"/>' +
      '<circle cx="27" cy="26" r="18.55" fill="none" stroke="#8aa06e" stroke-width="0.8" opacity="0.45"/>' +
      // 第0.5层：边缘环带（爆反裁剪后露出的主体色环）+ 虚线装甲接缝
      '<circle cx="27" cy="26" r="17.9" fill="none" stroke="#131a0e" stroke-width="0.8" stroke-dasharray="2.2 2.2" opacity="0.8"/>' +
      '<circle cx="27" cy="26" r="16.9" fill="none" stroke="#131a0e" stroke-width="0.7" opacity="0.5"/>' +
      // 第1层：正面爆反层（T-90 特征：爆反只覆盖炮塔正面右侧弧带，3 列 × 4 行，裁成圆）
      '<g clip-path="url(#ruclip)">' +
      '<rect x="28.5" y="9.5" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="37.5" y="9.5" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="46" y="11" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="28.5" y="18.5" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="37.5" y="18.5" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="46" y="20" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="28.5" y="27.5" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="37.5" y="27.5" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="46" y="29" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="28.5" y="36.5" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="37.5" y="36.5" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '<rect x="46" y="38" width="8" height="8" fill="url(#eraG)" stroke="#1c2415" stroke-width="1.1"/>' +
      '</g>' +
      // 第2层：车长周视镜座（炮塔顶部中央偏左，T-90 特征）
      '<circle cx="19" cy="17" r="3.6" fill="#4e5f40" stroke="#1b2214" stroke-width="1"/>' +
      '<circle cx="19" cy="17" r="2.6" fill="url(#hatchG)" stroke="#131a0e" stroke-width="0.9"/>' +
      '<circle cx="19" cy="17" r="1" fill="#d8e2cc"/>' +
      // 第3层：双舱盖（车长右前 + 炮手左后，T-90 双舱布局）
      '<circle cx="30" cy="17.5" r="4" fill="url(#hatchG)" stroke="#131a0e" stroke-width="1.1"/>' +
      '<circle cx="30" cy="17.5" r="1.5" fill="#2f3a26"/>' +
      '<line x1="26.8" y1="17.5" x2="33.2" y2="17.5" stroke="#131a0e" stroke-width="0.8" opacity="0.8"/>' +
      '<circle cx="20" cy="33" r="3.6" fill="url(#hatchG)" stroke="#131a0e" stroke-width="1.1"/>' +
      '<circle cx="20" cy="33" r="1.3" fill="#2f3a26"/>' +
      '<line x1="17.2" y1="33" x2="22.8" y2="33" stroke="#131a0e" stroke-width="0.8" opacity="0.8"/>' +
      // 第5层：设备（大炮长镜带底座、大红外灯、天线、储物箱）
      '<rect x="25.5" y="5" width="9.5" height="4.4" rx="1.2" fill="#1c2415" stroke="#0e130a" stroke-width="0.8"/>' +
      '<rect x="27" y="5.8" width="6" height="2.4" rx="0.8" fill="#5c6e47"/>' +
      '<circle cx="40.5" cy="31.5" r="4.6" fill="#1c2415" stroke="#0e130a" stroke-width="0.9"/>' +
      '<circle cx="40.5" cy="31.5" r="2.6" fill="#5c6e47"/>' +
      '<circle cx="40.5" cy="31.5" r="1.3" fill="#d8e2cc"/>' +
      '<line x1="31" y1="5" x2="25" y2="0" stroke="#2a3526" stroke-width="1.4"/>' +
      '<line x1="12" y1="41" x2="6" y2="46.5" stroke="#2a3526" stroke-width="1.1" opacity="0.8"/>' +
      '<rect x="8" y="33" width="3.6" height="4.2" rx="0.8" fill="#3d4a34" stroke="#1b2214" stroke-width="0.8"/>' +
      // 红点眼睛（炮塔炮管两侧，T90A 特征；附近有敌人时客户端叠加发光）
      '<circle cx="43" cy="16.5" r="2.4" fill="#8c1f14" stroke="#1c2313" stroke-width="0.7"/>' +
      '<circle cx="43" cy="16.5" r="1.1" fill="#e04030"/>' +
      '<circle cx="43" cy="35.5" r="2.4" fill="#8c1f14" stroke="#1c2313" stroke-width="0.7"/>' +
      '<circle cx="43" cy="35.5" r="1.1" fill="#e04030"/>' +
      '</svg>',
    // 日军 90式车体：四四方方 + 自卫队三色迷彩（茶/绿/黑）斑块 + 尾部格栅
    jpBody: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 84">' +
      '<defs><linearGradient id="jpb" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#51603f"/><stop offset="0.5" stop-color="#45523a"/><stop offset="1" stop-color="#37422c"/>' +
      '</linearGradient></defs>' +
      // 履带 + 履带齿
      '<rect x="3" y="3" width="94" height="13" rx="6" fill="#14170f"/>' +
      '<rect x="3" y="68" width="94" height="13" rx="6" fill="#14170f"/>' +
      '<line x1="8" y1="9.5" x2="97" y2="9.5" stroke="#0a0c06" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      '<line x1="8" y1="74.5" x2="97" y2="74.5" stroke="#0a0c06" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      // 侧裙板上下缘
      '<rect x="5" y="17" width="90" height="3.5" fill="#2a3026"/>' +
      '<rect x="5" y="63.5" width="90" height="3.5" fill="#2a3026"/>' +
      // 车体主体（四四方方，前缘斜削）
      '<path d="M18,19 L96,19 Q100,19 100,25 L100,59 Q100,65 96,65 L18,65 L10,56 L10,28 Z" fill="url(#jpb)" stroke="#23291f" stroke-width="1.5"/>' +
      // 三色迷彩斑块（茶色/黑色不规则多边形，自卫队标准涂装）
      '<path d="M62,21 L80,21 L75,31 L57,31 Z" fill="#6b5a3a"/>' +
      '<path d="M22,22 L40,22 L37,35 L19,35 Z" fill="#272d23"/>' +
      '<path d="M82,22 L97,22 L97,31 L85,31 Z" fill="#6b5a3a"/>' +
      '<path d="M19,49 L37,49 L40,62 L22,62 Z" fill="#6b5a3a"/>' +
      '<path d="M80,49 L97,49 L97,60 L83,60 Z" fill="#272d23"/>' +
      '<path d="M42,38 L58,38 L60,52 L43,52 Z" fill="#272d23"/>' +
      '<path d="M58,44 L72,44 L70,56 L55,56 Z" fill="#6b5a3a"/>' +
      // 前部楔形车头（方形斜削装甲）
      '<path d="M58,21 L96,21 Q99,21 99,25 L99,59 Q99,63 96,63 L58,63 L44,42 Z" fill="#4a573e" stroke="#23291f" stroke-width="1"/>' +
      // 尾部发动机格栅
      '<rect x="12" y="25" width="9" height="34" rx="2" fill="#3a442e" stroke="#23291f" stroke-width="0.9"/>' +
      '<line x1="12" y1="31.5" x2="21" y2="31.5" stroke="#23291f" stroke-width="0.9"/>' +
      '<line x1="12" y1="38" x2="21" y2="38" stroke="#23291f" stroke-width="0.9"/>' +
      '<line x1="12" y1="44.5" x2="21" y2="44.5" stroke="#23291f" stroke-width="0.9"/>' +
      '<line x1="12" y1="51" x2="21" y2="51" stroke="#23291f" stroke-width="0.9"/>' +
      // 前灯
      '<circle cx="97.5" cy="27" r="1.8" fill="#ffe9a3"/>' +
      '<circle cx="97.5" cy="57" r="1.8" fill="#ffe9a3"/>' +
      '</svg>',
    // 日军 90式炮塔：四四方方箱形 + 分层结构 + 三色迷彩
    jpTurret: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 52">' +
      '<defs><linearGradient id="jpt" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#4d5a3c"/><stop offset="1" stop-color="#39432c"/>' +
      '</linearGradient></defs>' +
      // 第1层：方形炮塔主体（90式=矩形箱式，边角小斜，与 M1 六边形/梅卡瓦窄条/99B方盒 区分）
      '<path d="M50,15 L43,8 L16,8 L8,15 L8,37 L16,44 L43,44 L50,37 Z" fill="url(#jpt)" stroke="#23291f" stroke-width="1.5"/>' +
      // 第2层：顶部装甲面板（内缩方框，分层感）
      '<path d="M46,17 L40,12 L19,12 L13,17 L13,35 L19,40 L40,40 L46,35 Z" fill="#4a573e" stroke="#23291f" stroke-width="1"/>' +
      '<path d="M48,18 L17,11" stroke="#6d7a54" stroke-width="0.9" opacity="0.6"/>' +
      // 迷彩斑块（炮塔面）
      '<path d="M44,13 L50,20 L44,27 L38,20 Z" fill="#6b5a3a"/>' +
      '<path d="M12,23 L21,23 L19,34 L10,32 Z" fill="#272d23"/>' +
      '<path d="M30,35 L41,35 L38,43 L27,40 Z" fill="#6b5a3a"/>' +
      // 第3层：方形炮盾（前缘根部）
      '<path d="M44,21 L50,26 L44,31 L39,26 Z" fill="#3a442e" stroke="#23291f" stroke-width="1"/>' +
      '<path d="M43,23 L48,26 L43,29 L40,26 Z" fill="#4a573e" stroke="#23291f" stroke-width="0.7"/>' +
      // 第4层：双舱盖凸台（车长右前 + 炮手左前，90式特征）
      '<circle cx="30" cy="19" r="5.6" fill="#3a442e" stroke="#23291f" stroke-width="1"/>' +
      '<circle cx="30" cy="19" r="4.3" fill="#59684a" stroke="#23291f" stroke-width="1"/>' +
      '<circle cx="30" cy="19" r="1.6" fill="#23291f"/>' +
      '<circle cx="19" cy="21" r="4.3" fill="#3a442e" stroke="#23291f" stroke-width="1"/>' +
      '<circle cx="19" cy="21" r="3.1" fill="#59684a" stroke="#23291f" stroke-width="1"/>' +
      '<circle cx="19" cy="21" r="1.2" fill="#23291f"/>' +
      // 第5层：设备（观瞄镜、周视镜、天线、后部储物箱）
      '<rect x="38" y="10.5" width="6.5" height="3.6" rx="1" fill="#1c2415" stroke="#23291f" stroke-width="0.7"/>' +
      '<rect x="39.2" y="11.4" width="4" height="1.8" rx="0.6" fill="#5a6e45"/>' +
      '<circle cx="33.5" cy="27" r="2.6" fill="#1c2415" stroke="#23291f" stroke-width="0.8"/>' +
      '<circle cx="33.5" cy="27" r="1.1" fill="#5a6e45"/>' +
      '<line x1="14" y1="8" x2="4" y2="1" stroke="#23291f" stroke-width="1.1"/>' +
      '<rect x="7.5" y="30" width="5.5" height="6.5" rx="1" fill="#3a442e" stroke="#23291f" stroke-width="0.8"/>' +
      '</svg>',
    // 以军 梅卡瓦车体：灰色、发动机前置 → 车体前宽后窄（梯形俯视，与所有矩形车体区分）、前部发动机舱+格栅、炮塔位偏后
    // 以军 梅卡瓦Mk4车体：灰、前宽后窄梯形（前置发动机）、车头推土铲、前置发动机舱格栅、侧裙板
    ilBody: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 84">' +
      '<defs><linearGradient id="ilbg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#8e9196"/><stop offset="0.5" stop-color="#74777d"/><stop offset="1" stop-color="#5a5d63"/>' +
      '</linearGradient>' +
      '<linearGradient id="ileng" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#7c7f85"/><stop offset="1" stop-color="#52555b"/>' +
      '</linearGradient></defs>' +
      // 履带 + 履带齿（梅卡瓦履带宽）
      '<rect x="2" y="3" width="96" height="14" rx="6" fill="#151619"/>' +
      '<rect x="2" y="67" width="96" height="14" rx="6" fill="#151619"/>' +
      '<line x1="8" y1="10" x2="97" y2="10" stroke="#0a0b0d" stroke-width="4.5" stroke-dasharray="3 4.6"/>' +
      '<line x1="8" y1="74" x2="97" y2="74" stroke="#0a0b0d" stroke-width="4.5" stroke-dasharray="3 4.6"/>' +
      // 侧裙板上缘
      '<rect x="4" y="17" width="92" height="3" fill="#45474c"/>' +
      '<rect x="4" y="64" width="92" height="3" fill="#45474c"/>' +
      // 车体主体：前宽后窄梯形（梅卡瓦标志：车头宽大、车尾收窄）
      '<path d="M36,16 L97,16 Q100,16 100,23 L100,61 Q100,68 97,68 L36,68 L18,57 L18,27 Z" fill="url(#ilbg)" stroke="#33353a" stroke-width="1.5"/>' +
      // 前置发动机舱（车头宽大部分）
      '<path d="M58,17 L96,17 Q99,17 99,23 L99,61 Q99,67 96,67 L58,67 L44,42 Z" fill="url(#ileng)" stroke="#33353a" stroke-width="1.2"/>' +
      // 发动机散热格栅（大面板）
      '<rect x="60" y="19" width="22" height="24" rx="2" fill="#5a5d63" stroke="#33353a" stroke-width="1"/>' +
      '<line x1="62" y1="23.5" x2="80" y2="23.5" stroke="#33353a" stroke-width="1.1"/>' +
      '<line x1="62" y1="28" x2="80" y2="28" stroke="#33353a" stroke-width="1.1"/>' +
      '<line x1="62" y1="32.5" x2="80" y2="32.5" stroke="#33353a" stroke-width="1.1"/>' +
      '<line x1="62" y1="37" x2="80" y2="37" stroke="#33353a" stroke-width="1.1"/>' +
      // 发动机侧散热栅
      '<rect x="84" y="19" width="12" height="46" rx="2" fill="#5a5d63" stroke="#33353a" stroke-width="1"/>' +
      '<line x1="87" y1="21" x2="87" y2="63" stroke="#33353a" stroke-width="1"/>' +
      '<line x1="90.5" y1="21" x2="90.5" y2="63" stroke="#33353a" stroke-width="1"/>' +
      '<line x1="94" y1="21" x2="94" y2="63" stroke="#33353a" stroke-width="1"/>' +
      // 车头推土铲（梅卡瓦车头 V 形铲板）
      '<path d="M96,18 L100,42 L96,66 L90,66 L95,42 L90,18 Z" fill="#56595f" stroke="#33353a" stroke-width="1"/>' +
      // 后部（左）乘员舱门
      '<rect x="20" y="21" width="9" height="42" rx="2" fill="#6d7076" stroke="#33353a" stroke-width="1"/>' +
      '<line x1="22" y1="29" x2="27" y2="29" stroke="#33353a" stroke-width="0.8"/>' +
      '<line x1="22" y1="42" x2="27" y2="42" stroke="#33353a" stroke-width="0.8"/>' +
      '<line x1="22" y1="55" x2="27" y2="55" stroke="#33353a" stroke-width="0.8"/>' +
      // 深灰斑
      '<path d="M26,19 L44,19 L40,33 L24,33 Z" fill="#56595f"/>' +
      '<path d="M22,48 L38,48 L35,63 L19,63 Z" fill="#6d7076"/>' +
      // 前灯
      '<circle cx="97.5" cy="22" r="1.8" fill="#ffe9a3"/>' +
      '<circle cx="97.5" cy="62" r="1.8" fill="#ffe9a3"/>' +
      '</svg>',
    // 以军 梅卡瓦Mk4炮塔：中性灰、窄长条（前窄后宽）、前部斜装甲板、方形观瞄塔、尾舱吊篮
    ilTurret: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 52">' +
      '<defs><linearGradient id="iltg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#8e9196"/><stop offset="1" stop-color="#5a5d63"/>' +
      '</linearGradient></defs>' +
      // 第1层：窄长炮塔主体（前窄后宽楔形长条，整体比车体窄得多）
      '<path d="M52,19 L47,12 L12,12 L6,19 L6,33 L12,40 L47,40 L52,33 Z" fill="url(#iltg)" stroke="#33353a" stroke-width="1.5"/>' +
      // 第2层：前部倾斜装甲板（Mk4 炮塔前缘斜面，上下对称）
      '<path d="M52,19 L47,12 L34,12 L43,19 Z" fill="#82858b" stroke="#33353a" stroke-width="1"/>' +
      '<path d="M52,33 L47,40 L34,40 L43,33 Z" fill="#70737a" stroke="#33353a" stroke-width="1"/>' +
      // 顶部装甲面板
      '<path d="M46,19 L41,14 L17,14 L11,19 L11,33 L17,38 L41,38 L46,33 Z" fill="#86898f" stroke="#33353a" stroke-width="1"/>' +
      // 低对比斑
      '<path d="M40,14 L46,19 L40,24 L34,19 Z" fill="#5f6268"/>' +
      '<path d="M14,26 L21,26 L19,36 L12,34 Z" fill="#6d7076"/>' +
      // 第3层：炮盾
      '<path d="M46,22 L52,26 L46,30 L41,26 Z" fill="#5f6268" stroke="#33353a" stroke-width="1"/>' +
      // 第4层：方形观瞄塔（梅卡瓦 Mk4 标志：炮塔顶部方形周视镜塔）
      '<rect x="21" y="15" width="13" height="13" rx="1.5" fill="#56595f" stroke="#33353a" stroke-width="1"/>' +
      '<rect x="23" y="17" width="9" height="9" rx="1" fill="#75787e" stroke="#33353a" stroke-width="0.9"/>' +
      '<circle cx="27.5" cy="21.5" r="2.3" fill="#33353a"/>' +
      '<circle cx="27.5" cy="21.5" r="1" fill="#c7c9cd"/>' +
      // 装填手舱盖
      '<circle cx="16" cy="21" r="3.6" fill="#5f6268" stroke="#33353a" stroke-width="1"/>' +
      '<circle cx="16" cy="21" r="2.6" fill="#86898f" stroke="#33353a" stroke-width="0.9"/>' +
      '<circle cx="16" cy="21" r="1" fill="#33353a"/>' +
      // 第5层：尾舱吊篮（网格储物篮）
      '<rect x="6" y="15" width="5.5" height="22" rx="1" fill="none" stroke="#5f6268" stroke-width="1.4"/>' +
      '<line x1="8.75" y1="15" x2="8.75" y2="37" stroke="#5f6268" stroke-width="0.9"/>' +
      '<line x1="7" y1="19.5" x2="10.5" y2="19.5" stroke="#5f6268" stroke-width="0.9"/>' +
      '<line x1="7" y1="24" x2="10.5" y2="24" stroke="#5f6268" stroke-width="0.9"/>' +
      '<line x1="7" y1="28.5" x2="10.5" y2="28.5" stroke="#5f6268" stroke-width="0.9"/>' +
      '<line x1="7" y1="33" x2="10.5" y2="33" stroke="#5f6268" stroke-width="0.9"/>' +
      // 设备：天线、观瞄
      '<line x1="16" y1="12" x2="5" y2="2" stroke="#33353a" stroke-width="1.1"/>' +
      '<circle cx="38" cy="14" r="1.6" fill="#26272a" stroke="#33353a" stroke-width="0.6"/>' +
      '<circle cx="38" cy="14" r="0.7" fill="#8e9196"/>' +
      '</svg>',
    // 中国 99B车体：沙色 + 彩色格子数码迷彩（99式沙漠数码涂装）+ 前楔车头 + 车尾侧面格栅装甲
    cnBody: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 84">' +
      '<defs><linearGradient id="cnbg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#cdb87f"/><stop offset="0.5" stop-color="#bca468"/><stop offset="1" stop-color="#9a8452"/>' +
      '</linearGradient></defs>' +
      // 履带 + 履带齿
      '<rect x="3" y="3" width="94" height="13" rx="6" fill="#1a1710"/>' +
      '<rect x="3" y="68" width="94" height="13" rx="6" fill="#1a1710"/>' +
      '<line x1="8" y1="9.5" x2="97" y2="9.5" stroke="#0c0a05" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      '<line x1="8" y1="74.5" x2="97" y2="74.5" stroke="#0c0a05" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      // 侧裙板上下缘
      '<rect x="5" y="17" width="90" height="3.5" fill="#7a6a42"/>' +
      '<rect x="5" y="63.5" width="90" height="3.5" fill="#7a6a42"/>' +
      // 车体主体
      '<path d="M18,19 L96,19 Q100,19 100,25 L100,59 Q100,65 96,65 L18,65 L10,56 L10,28 Z" fill="url(#cnbg)" stroke="#5c4f31" stroke-width="1.5"/>' +
      // 彩色数码迷彩（99式沙漠数码：浅沙/沙/棕/深棕/棕黑 5 色小格，非绿色系）
      '<rect x="24" y="21" width="8" height="8" fill="#6b5a3a"/>' +
      '<rect x="33" y="21" width="8" height="8" fill="#e0cd9c"/>' +
      '<rect x="42" y="21" width="8" height="8" fill="#463a26"/>' +
      '<rect x="51" y="21" width="8" height="8" fill="#a8915a"/>' +
      '<rect x="60" y="21" width="8" height="8" fill="#cdb87f"/>' +
      '<rect x="69" y="21" width="8" height="8" fill="#6b5a3a"/>' +
      '<rect x="24" y="30" width="8" height="8" fill="#cdb87f"/>' +
      '<rect x="33" y="30" width="8" height="8" fill="#463a26"/>' +
      '<rect x="42" y="30" width="8" height="8" fill="#a8915a"/>' +
      '<rect x="51" y="30" width="8" height="8" fill="#e0cd9c"/>' +
      '<rect x="60" y="30" width="8" height="8" fill="#6b5a3a"/>' +
      '<rect x="69" y="30" width="8" height="8" fill="#a8915a"/>' +
      '<rect x="24" y="46" width="8" height="8" fill="#a8915a"/>' +
      '<rect x="33" y="46" width="8" height="8" fill="#cdb87f"/>' +
      '<rect x="42" y="46" width="8" height="8" fill="#6b5a3a"/>' +
      '<rect x="51" y="46" width="8" height="8" fill="#463a26"/>' +
      '<rect x="60" y="46" width="8" height="8" fill="#e0cd9c"/>' +
      '<rect x="69" y="46" width="8" height="8" fill="#cdb87f"/>' +
      '<rect x="24" y="55" width="8" height="8" fill="#e0cd9c"/>' +
      '<rect x="33" y="55" width="8" height="8" fill="#6b5a3a"/>' +
      '<rect x="42" y="55" width="8" height="8" fill="#a8915a"/>' +
      '<rect x="51" y="55" width="8" height="8" fill="#cdb87f"/>' +
      '<rect x="60" y="55" width="8" height="8" fill="#463a26"/>' +
      '<rect x="69" y="55" width="8" height="8" fill="#6b5a3a"/>' +
      // 前部大型楔形首上装甲（99式标志：V形大楔块，俯视车头像箭头；中央圆尖+两侧斜边后掠+楔脊线）
      '<path d="M48,20 L93,27 Q100,35 100,42 Q100,49 93,57 L48,64 L36,42 Z" fill="#b39a5f" stroke="#5c4f31" stroke-width="1"/>' +
      // 楔脊线（座圈中点直指车头尖）
      '<line x1="40" y1="42" x2="97" y2="42" stroke="#8d7a4b" stroke-width="1"/>' +
      // 楔面数码格子（浅色块叠在楔上）
      '<rect x="70" y="30" width="8" height="8" fill="#cdb87f"/>' +
      '<rect x="80" y="40" width="8" height="8" fill="#8a7748"/>' +
      '<rect x="62" y="46" width="8" height="8" fill="#a8915a"/>' +
      '<rect x="72" y="52" width="8" height="8" fill="#cdb87f"/>' +
      // 楔形侧裙板（炮塔两侧车体向外凸出的楔块——99A/B 侧面特征）
      '<path d="M16,21 L40,21 L30,42 L40,63 L16,63 L8,52 L8,32 Z" fill="#a8915a" stroke="#5c4f31" stroke-width="1"/>' +
      '<line x1="20" y1="30" x2="30" y2="42" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="20" y1="54" x2="30" y2="42" stroke="#7a6a42" stroke-width="0.8"/>' +
      // 车尾侧面格栅装甲（防RPG栅栏笼）
      '<rect x="10" y="18" width="6" height="48" rx="1.5" fill="none" stroke="#7a6a42" stroke-width="1.4"/>' +
      '<line x1="13" y1="18" x2="13" y2="66" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="11" y1="22" x2="15" y2="22" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="11" y1="30" x2="15" y2="30" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="11" y1="38" x2="15" y2="38" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="11" y1="46" x2="15" y2="46" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="11" y1="54" x2="15" y2="54" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="11" y1="62" x2="15" y2="62" stroke="#7a6a42" stroke-width="0.8"/>' +
      // 尾部格栅
      '<rect x="16" y="25" width="7" height="34" rx="2" fill="#8d7a4b" stroke="#5c4f31" stroke-width="0.9"/>' +
      '<line x1="16" y1="31.5" x2="23" y2="31.5" stroke="#5c4f31" stroke-width="0.9"/>' +
      '<line x1="16" y1="38" x2="23" y2="38" stroke="#5c4f31" stroke-width="0.9"/>' +
      '<line x1="16" y1="44.5" x2="23" y2="44.5" stroke="#5c4f31" stroke-width="0.9"/>' +
      '<line x1="16" y1="51" x2="23" y2="51" stroke="#5c4f31" stroke-width="0.9"/>' +
      // 前灯
      '<circle cx="97.5" cy="27" r="1.8" fill="#ffe9a3"/>' +
      '<circle cx="97.5" cy="57" r="1.8" fill="#ffe9a3"/>' +
      '</svg>',
    // 中国 99B炮塔：沙色大方箱（前缘近垂直）+ 前部外挂爆反板 + 顶部雷达罩 + 彩色数码格子 + 背面格栅
    cnTurret: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 52">' +
      '<defs><linearGradient id="cntg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#c2aa6d"/><stop offset="1" stop-color="#93804f"/>' +
      '</linearGradient></defs>' +
      // 第1层：方形炮塔主体（99式=大方箱，前缘近垂直，非六边形）
      '<path d="M50,16 L45,9 L14,9 L8,16 L8,36 L14,43 L45,43 L50,36 Z" fill="url(#cntg)" stroke="#5c4f31" stroke-width="1.5"/>' +
      // 第2层：顶部装甲面板
      '<path d="M46,18 L41,13 L18,13 L12,18 L12,34 L18,39 L41,39 L46,34 Z" fill="#b39a5f" stroke="#5c4f31" stroke-width="1"/>' +
      // 彩色数码格子（沙/浅沙/棕/深棕/棕黑）
      '<rect x="36" y="14" width="7" height="7" fill="#e0cd9c"/>' +
      '<rect x="44" y="14" width="6" height="7" fill="#463a26"/>' +
      '<rect x="14" y="22" width="7" height="7" fill="#463a26"/>' +
      '<rect x="22" y="22" width="7" height="7" fill="#cdb87f"/>' +
      '<rect x="30" y="32" width="7" height="7" fill="#a8915a"/>' +
      '<rect x="38" y="32" width="7" height="7" fill="#6b5a3a"/>' +
      '<rect x="20" y="32" width="7" height="7" fill="#e0cd9c"/>' +
      // 第3层：前部外挂爆反板（99式炮塔正面两侧的突出爆反板）
      '<rect x="43.5" y="10.5" width="6.5" height="13" rx="1" fill="#a8915a" stroke="#5c4f31" stroke-width="1"/>' +
      '<rect x="43.5" y="28.5" width="6.5" height="13" rx="1" fill="#a8915a" stroke="#5c4f31" stroke-width="1"/>' +
      '<line x1="45" y1="15" x2="48.5" y2="15" stroke="#5c4f31" stroke-width="0.9"/>' +
      '<line x1="45" y1="33" x2="48.5" y2="33" stroke="#5c4f31" stroke-width="0.9"/>' +
      // 炮盾
      '<path d="M46,22 L52,26 L46,30 L41,26 Z" fill="#8d7a4b" stroke="#5c4f31" stroke-width="1"/>' +
      // 第4层：炮塔背面格栅装甲
      '<rect x="6" y="10" width="6" height="32" rx="1.5" fill="none" stroke="#7a6a42" stroke-width="1.4"/>' +
      '<line x1="9" y1="10" x2="9" y2="42" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="7" y1="14" x2="11" y2="14" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="7" y1="20" x2="11" y2="20" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="7" y1="26" x2="11" y2="26" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="7" y1="32" x2="11" y2="32" stroke="#7a6a42" stroke-width="0.8"/>' +
      '<line x1="7" y1="38" x2="11" y2="38" stroke="#7a6a42" stroke-width="0.8"/>' +
      // 第5层：双舱盖凸台
      '<circle cx="29" cy="19" r="5" fill="#8d7a4b" stroke="#5c4f31" stroke-width="1"/>' +
      '<circle cx="29" cy="19" r="3.7" fill="#c2aa6d" stroke="#5c4f31" stroke-width="1"/>' +
      '<circle cx="29" cy="19" r="1.4" fill="#5c4f31"/>' +
      '<circle cx="19" cy="22" r="3.8" fill="#8d7a4b" stroke="#5c4f31" stroke-width="1"/>' +
      '<circle cx="19" cy="22" r="2.7" fill="#c2aa6d" stroke="#5c4f31" stroke-width="1"/>' +
      // 第6层：顶部毫米波雷达罩（99A 标志：炮塔顶部偏后圆形雷达罩）
      '<circle cx="33" cy="31" r="4.4" fill="#3a3220" stroke="#5c4f31" stroke-width="1"/>' +
      '<circle cx="33" cy="31" r="3.2" fill="#5c4f31" stroke="#5c4f31" stroke-width="0.8"/>' +
      '<circle cx="33" cy="31" r="1.4" fill="#e0cd9c"/>' +
      // 设备：观瞄镜、天线
      '<rect x="35" y="10.5" width="6" height="3.4" rx="1" fill="#3a3220" stroke="#5c4f31" stroke-width="0.7"/>' +
      '<rect x="36" y="11.3" width="4" height="1.8" rx="0.6" fill="#e0cd9c"/>' +
      '<line x1="15" y1="9" x2="5" y2="2" stroke="#5c4f31" stroke-width="1.1"/>' +
      '</svg>',
    // 欧盟 豹二A6车体：黑灰涂装 + 前楔车头
    deBody: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 84">' +
      '<defs><linearGradient id="debg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#4a4d52"/><stop offset="0.5" stop-color="#3a3d42"/><stop offset="1" stop-color="#2b2d31"/>' +
      '</linearGradient></defs>' +
      // 履带 + 履带齿
      '<rect x="3" y="3" width="94" height="13" rx="6" fill="#141518"/>' +
      '<rect x="3" y="68" width="94" height="13" rx="6" fill="#141518"/>' +
      '<line x1="8" y1="9.5" x2="97" y2="9.5" stroke="#08090b" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      '<line x1="8" y1="74.5" x2="97" y2="74.5" stroke="#08090b" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      // 侧裙板上下缘
      '<rect x="5" y="17" width="90" height="3.5" fill="#222428"/>' +
      '<rect x="5" y="63.5" width="90" height="3.5" fill="#222428"/>' +
      // 车体主体
      '<path d="M18,19 L96,19 Q100,19 100,25 L100,59 Q100,65 96,65 L18,65 L10,56 L10,28 Z" fill="url(#debg)" stroke="#18191c" stroke-width="1.5"/>' +
      // 深色迷彩斑
      '<path d="M30,20 L48,20 L44,33 L27,33 Z" fill="#222428"/>' +
      '<path d="M56,22 L74,22 L70,34 L54,34 Z" fill="#4a4d52"/>' +
      '<path d="M24,46 L40,46 L38,60 L22,60 Z" fill="#4a4d52"/>' +
      '<path d="M62,48 L80,48 L78,60 L60,60 Z" fill="#222428"/>' +
      // 前部楔形车头
      '<path d="M58,21 L96,21 Q99,21 99,25 L99,59 Q99,63 96,63 L58,63 L44,42 Z" fill="#414449" stroke="#18191c" stroke-width="1"/>' +
      // 尾部储物篮（豹2 标志：车体尾部两侧网格储物篮）
      '<rect x="10" y="20" width="8" height="19" rx="1.5" fill="none" stroke="#4a4d52" stroke-width="1.3"/>' +
      '<line x1="14" y1="20" x2="14" y2="39" stroke="#4a4d52" stroke-width="0.8"/>' +
      '<line x1="11" y1="23.8" x2="17" y2="23.8" stroke="#4a4d52" stroke-width="0.8"/>' +
      '<line x1="11" y1="27.6" x2="17" y2="27.6" stroke="#4a4d52" stroke-width="0.8"/>' +
      '<line x1="11" y1="31.4" x2="17" y2="31.4" stroke="#4a4d52" stroke-width="0.8"/>' +
      '<line x1="11" y1="35.2" x2="17" y2="35.2" stroke="#4a4d52" stroke-width="0.8"/>' +
      '<rect x="10" y="45" width="8" height="19" rx="1.5" fill="none" stroke="#4a4d52" stroke-width="1.3"/>' +
      '<line x1="14" y1="45" x2="14" y2="64" stroke="#4a4d52" stroke-width="0.8"/>' +
      '<line x1="11" y1="48.8" x2="17" y2="48.8" stroke="#4a4d52" stroke-width="0.8"/>' +
      '<line x1="11" y1="52.6" x2="17" y2="52.6" stroke="#4a4d52" stroke-width="0.8"/>' +
      '<line x1="11" y1="56.4" x2="17" y2="56.4" stroke="#4a4d52" stroke-width="0.8"/>' +
      '<line x1="11" y1="60.2" x2="17" y2="60.2" stroke="#4a4d52" stroke-width="0.8"/>' +
      // 尾部发动机格栅
      '<rect x="21" y="26" width="8" height="32" rx="2" fill="#2b2d31" stroke="#18191c" stroke-width="0.9"/>' +
      '<line x1="21" y1="32" x2="29" y2="32" stroke="#18191c" stroke-width="0.9"/>' +
      '<line x1="21" y1="38" x2="29" y2="38" stroke="#18191c" stroke-width="0.9"/>' +
      '<line x1="21" y1="44" x2="29" y2="44" stroke="#18191c" stroke-width="0.9"/>' +
      '<line x1="21" y1="50" x2="29" y2="50" stroke="#18191c" stroke-width="0.9"/>' +
      // 前灯
      '<circle cx="97.5" cy="27" r="1.8" fill="#ffe9a3"/>' +
      '<circle cx="97.5" cy="57" r="1.8" fill="#ffe9a3"/>' +
      '</svg>',
    // 欧盟 豹二A6炮塔：黑灰 + 铲头式炮塔前部（宽楔形如铲）+ 分层
    deTurret: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 52">' +
      '<defs><linearGradient id="detg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#45484d"/><stop offset="1" stop-color="#2e3034"/>' +
      '</linearGradient></defs>' +
      // 第1层：箭头/铲头炮塔主体（豹2 标志：炮管座处箭头尖点、两侧斜翼直边向后展开、尾部平直）
      '<path d="M52,26 L46,9 L13,9 L5,20 L5,32 L13,43 L46,43 Z" fill="url(#detg)" stroke="#18191c" stroke-width="1.5"/>' +
      // 铲头楔面（箭头两翼）
      '<path d="M52,26 L46,9 L35,9 L44,26 Z" fill="#4a4d52" stroke="#18191c" stroke-width="0.9"/>' +
      '<path d="M52,26 L46,43 L35,43 L44,26 Z" fill="#3a3d42" stroke="#18191c" stroke-width="0.9"/>' +
      // 第2层：顶部装甲面板
      '<path d="M47,22 L42,15 L17,15 L11,22 L11,30 L17,37 L42,37 L47,30 Z" fill="#3a3d42" stroke="#18191c" stroke-width="1"/>' +
      // 迷彩斑
      '<path d="M40,15 L46,21 L40,27 L34,21 Z" fill="#4a4d52"/>' +
      '<path d="M14,25 L20,25 L18,33 L12,31 Z" fill="#222428"/>' +
      // 第3层：炮盾（铲头尖点处）
      '<path d="M47,23 L52,26 L47,29 L42,26 Z" fill="#2e3034" stroke="#18191c" stroke-width="1"/>' +
      // 第4层：双舱盖 + 观瞄
      '<circle cx="31" cy="21" r="5.6" fill="#2e3034" stroke="#18191c" stroke-width="1"/>' +
      '<circle cx="31" cy="21" r="4.2" fill="#45484d" stroke="#18191c" stroke-width="1"/>' +
      '<circle cx="31" cy="21" r="1.5" fill="#18191c"/>' +
      '<circle cx="21" cy="24" r="4.2" fill="#2e3034" stroke="#18191c" stroke-width="1"/>' +
      '<circle cx="21" cy="24" r="3" fill="#45484d" stroke="#18191c" stroke-width="1"/>' +
      '<rect x="35" y="12" width="6" height="3.4" rx="1" fill="#17181a" stroke="#18191c" stroke-width="0.7"/>' +
      '<rect x="36" y="12.8" width="4" height="1.8" rx="0.6" fill="#6a6e74"/>' +
      // 第5层：设备（车长周视镜、炮手观瞄、天线、尾部储物箱）
      '<circle cx="39" cy="17.5" r="2.5" fill="#17181a" stroke="#18191c" stroke-width="0.8"/>' +
      '<circle cx="39" cy="17.5" r="1.2" fill="#6a6e74"/>' +
      '<circle cx="27" cy="17" r="2" fill="#17181a" stroke="#18191c" stroke-width="0.7"/>' +
      '<circle cx="27" cy="17" r="0.9" fill="#6a6e74"/>' +
      '<line x1="15" y1="10" x2="5" y2="3" stroke="#18191c" stroke-width="1.1"/>' +
      '<rect x="7" y="30" width="5.5" height="7" rx="1" fill="#2e3034" stroke="#18191c" stroke-width="0.8"/>' +
      '</svg>',
    // 中国 红箭10导弹发射车车体：履带式底盘（真实型号），扁平箱式车身无炮塔座圈，后部发射架平台，前部驾驶舱
    hj10Body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 84">' +
      '<defs><linearGradient id="hjb" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#5a6846"/><stop offset="0.5" stop-color="#475434"/><stop offset="1" stop-color="#36402a"/>' +
      '</linearGradient></defs>' +
      // 履带 + 履带齿（履带式底盘）
      '<rect x="3" y="3" width="94" height="13" rx="6" fill="#14170f"/>' +
      '<rect x="3" y="68" width="94" height="13" rx="6" fill="#14170f"/>' +
      '<line x1="8" y1="9.5" x2="97" y2="9.5" stroke="#0a0c06" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      '<line x1="8" y1="74.5" x2="97" y2="74.5" stroke="#0a0c06" stroke-width="4" stroke-dasharray="2.6 4.4"/>' +
      // 侧裙板上缘
      '<rect x="5" y="17" width="90" height="3.5" fill="#2a3026"/>' +
      '<rect x="5" y="63.5" width="90" height="3.5" fill="#2a3026"/>' +
      // 车体主体（扁平箱式：导弹发射车，比主战坦克低矮方正，前后同宽）
      '<path d="M14,19 L96,19 Q100,19 100,25 L100,59 Q100,65 96,65 L14,65 L7,56 L7,28 Z" fill="url(#hjb)" stroke="#20271a" stroke-width="1.5"/>' +
      // 军绿迷彩斑（黑 + 沙）
      '<path d="M40,21 L58,21 L54,32 L36,32 Z" fill="#2c3324"/>' +
      '<path d="M70,20 L88,20 L84,30 L68,30 Z" fill="#6b5a3a"/>' +
      '<path d="M22,44 L40,44 L37,58 L19,58 Z" fill="#6b5a3a"/>' +
      '<path d="M62,44 L80,44 L76,58 L58,58 Z" fill="#2c3324"/>' +
      // 后部发射架安装平台（左端凹槽：发射架在此升降旋转，无炮塔座圈）
      '<path d="M14,21 L44,21 L38,63 L14,63 L8,55 L8,29 Z" fill="#3d4a34" stroke="#20271a" stroke-width="1"/>' +
      '<line x1="10" y1="26" x2="42" y2="26" stroke="#20271a" stroke-width="0.8" opacity="0.5"/>' +
      '<line x1="10" y1="58" x2="42" y2="58" stroke="#20271a" stroke-width="0.8" opacity="0.5"/>' +
      // 前部（右）驾驶舱（装甲车：斜挡风玻璃 + 舱门）
      '<path d="M76,21 L95,21 Q99,21 99,26 L99,58 Q99,63 95,63 L76,63 L68,42 Z" fill="#4c5a3c" stroke="#20271a" stroke-width="1"/>' +
      '<rect x="79" y="23" width="15" height="7" rx="1.5" fill="#1c2216" stroke="#20271a" stroke-width="0.9"/>' +
      '<line x1="81" y1="25.5" x2="92" y2="25.5" stroke="#5a6846" stroke-width="1"/>' +
      '<line x1="81" y1="28" x2="92" y2="28" stroke="#5a6846" stroke-width="1"/>' +
      // 前灯
      '<circle cx="97.5" cy="27" r="1.8" fill="#ffe9a3"/>' +
      '<circle cx="97.5" cy="57" r="1.8" fill="#ffe9a3"/>' +
      '</svg>',
    // 中国 红箭10发射架（独立设计，非炮塔）：左右两根方形导弹发射箱（厚实方箱，箱口方形面）+ 中间观瞄 + 底座
    hj10Turret: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 52">' +
      '<defs><linearGradient id="hjt" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#4c5a3c"/><stop offset="1" stop-color="#2f3a26"/>' +
      '</linearGradient>' +
      // 发射箱渐变（箱体立体感）
      '<linearGradient id="hjbox" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="#55663e"/><stop offset="1" stop-color="#39452b"/>' +
      '</linearGradient></defs>' +
      // 第1层：底座（贴图左半，发射架旋转基座，矮小）
      '<path d="M24,13 L20,9 L8,9 L4,15 L4,37 L8,43 L20,43 L24,39 Z" fill="url(#hjt)" stroke="#20271a" stroke-width="1.2"/>' +
      '<line x1="6" y1="18" x2="22" y2="18" stroke="#20271a" stroke-width="0.7" opacity="0.5"/>' +
      '<line x1="6" y1="34" x2="22" y2="34" stroke="#20271a" stroke-width="0.7" opacity="0.5"/>' +
      // 第2层：上方发射箱（方形箱体：厚、方角、箱盖铰链、方形发射口）
      '<rect x="22" y="10" width="27" height="13" rx="1" fill="url(#hjbox)" stroke="#20271a" stroke-width="1.2"/>' +
      // 箱盖铰链线（箱体中部横线——箱体特征，绝非炮管）
      '<line x1="22" y1="16.5" x2="49" y2="16.5" stroke="#20271a" stroke-width="0.9"/>' +
      // 方形发射口（箱口方形面，深色）
      '<rect x="45" y="11.5" width="4" height="10" fill="#14170f"/>' +
      // 箱体加强条
      '<line x1="31" y1="10" x2="31" y2="23" stroke="#20271a" stroke-width="0.8"/>' +
      '<line x1="39" y1="10" x2="39" y2="23" stroke="#20271a" stroke-width="0.8"/>' +
      // 第3层：下方发射箱（同样方形箱体）
      '<rect x="22" y="29" width="27" height="13" rx="1" fill="url(#hjbox)" stroke="#20271a" stroke-width="1.2"/>' +
      '<line x1="22" y1="35.5" x2="49" y2="35.5" stroke="#20271a" stroke-width="0.9"/>' +
      '<rect x="45" y="30.5" width="4" height="10" fill="#14170f"/>' +
      '<line x1="31" y1="29" x2="31" y2="42" stroke="#20271a" stroke-width="0.8"/>' +
      '<line x1="39" y1="29" x2="39" y2="42" stroke="#20271a" stroke-width="0.8"/>' +
      // 第4层：中间观瞄设备（低矮小方块）
      '<rect x="12" y="20" width="7" height="12" rx="1" fill="#1c2415" stroke="#20271a" stroke-width="0.8"/>' +
      '<rect x="13.5" y="22" width="4" height="2" rx="0.6" fill="#5a6e45"/>' +
      '<circle cx="15.5" cy="28" r="1.8" fill="#1c2415" stroke="#20271a" stroke-width="0.6"/>' +
      '<circle cx="15.5" cy="28" r="0.8" fill="#5a6e45"/>' +
      // 天线
      '<line x1="10" y1="10" x2="3" y2="3" stroke="#20271a" stroke-width="1"/>' +
      '</svg>',
  };
  const TANK_IMAGES = {};
  (function loadTankImages() {
    for (const k of Object.keys(TANK_SVG)) {
      const img = new Image();
      img.onload = () => { TANK_IMAGES[k] = img; };
      img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(TANK_SVG[k]);
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
    const bodyImg = TANK_IMAGES[({ ru: 'ruBody', jp: 'jpBody', il: 'ilBody', cn: 'cnBody', de: 'deBody', hj10: 'hj10Body' }[t.ty] || 'usBody')];
    if (bodyImg) {
      // 车体铺满碰撞盒 52x44
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
    // 炮塔座圈（基座层：比炮塔大一圈的暗色底盘，车体上；红箭10 无炮塔座圈）
    if (t.ty !== 'hj10') {
      ctx.fillStyle = t.ty === 'ru' ? '#1d2617' : '#2e2a1e';
      ctx.beginPath(); ctx.arc(0, 0, 15.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = t.ty === 'ru' ? '#13190e' : '#221d12';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(0, 0, 15.5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
    // 炮塔贴图（损坏时炮管歪斜）+ 炮管（长度与子弹出生点一致）
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.ta + (t.prt && !t.prt[1] ? 0.5 : 0));
    const turImg = TANK_IMAGES[({ ru: 'ruTurret', jp: 'jpTurret', il: 'ilTurret', cn: 'cnTurret', de: 'deTurret', hj10: 'hj10Turret' }[t.ty] || 'usTurret')];
    if (turImg) {
      // 炮塔本体（大炮塔：40x37 盖住车体大半，不含炮管）
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(turImg, -20, -18.5, 40, 37);
    } else {
      ctx.fillStyle = t.ty === 'ru' ? '#4a5a48' : '#46524a';
      ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
    }
    // 炮管（与服务器子弹出生点 34 一致；红箭10 无炮管——发射箱贴图自带发射装置）
    if (t.ty !== 'hj10') {
      // 防盾根座（连接炮塔，暗色基座）
      ctx.fillStyle = '#2a2f3a';
      rr(4, -4.6, 10, 9.2, 2.5); ctx.fill();
      // 管身尾段（粗）
      ctx.fillStyle = '#232c38';
      rr(9, -3, 24, 6, 3); ctx.fill();
      // 热护套（中段） + 卡箍
      ctx.fillStyle = '#3a4656';
      rr(14, -3.7, 17, 7.4, 3.5); ctx.fill();
      ctx.fillStyle = '#232c38';
      ctx.fillRect(17, -3.7, 1.6, 7.4);
      ctx.fillRect(27, -3.7, 1.6, 7.4);
      // 管身前段（细）
      ctx.fillStyle = '#2b3542';
      rr(32, -2.4, 9, 4.8, 2.2); ctx.fill();
      // 炮口制退器
      ctx.fillStyle = '#d8dee9';
      rr(41, -3.4, 6.5, 6.8, 1.2); ctx.fill();
      ctx.fillStyle = '#9aa7b8';
      ctx.fillRect(43.5, -3.4, 1.3, 6.8);
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
    // 起火：车体火焰（弹药架起火 am 更剧烈：大火柱 + 火星 + 黑烟）
    if (t.fr > 0) {
      if (t.am) {
        // 弹药架起火：剧烈火焰特效
        if (Math.random() < 0.9) {
          particles.push({
            x: t.x + (Math.random() - 0.5) * 20, y: t.y + (Math.random() - 0.5) * 20,
            vx: (Math.random() - 0.5) * 60, vy: -110 - Math.random() * 60,
            life: 0.7, maxLife: 0.7, size: 9 + Math.random() * 8, color: Math.random() < 0.6 ? '#ff5722' : '#ffb300',
          });
        }
        if (Math.random() < 0.4) {
          particles.push({ // 火星飞溅
            x: t.x + (Math.random() - 0.5) * 26, y: t.y + (Math.random() - 0.5) * 26,
            vx: (Math.random() - 0.5) * 160, vy: (Math.random() - 0.5) * 160 - 40,
            life: 0.4, maxLife: 0.4, size: 2 + Math.random() * 2, color: '#fff3c0',
          });
        }
        if (Math.random() < 0.5) {
          particles.push({ // 黑烟柱
            x: t.x + (Math.random() - 0.5) * 10, y: t.y + (Math.random() - 0.5) * 10,
            vx: (Math.random() - 0.5) * 20, vy: -70 - Math.random() * 30,
            life: 1.4, maxLife: 1.4, size: 12 + Math.random() * 10, color: '#2a2a2e',
          });
        }
      } else if (Math.random() < 0.6) {
        particles.push({
          x: t.x + (Math.random() - 0.5) * 30, y: t.y + (Math.random() - 0.5) * 30,
          vx: (Math.random() - 0.5) * 40, vy: -60 - Math.random() * 40,
          life: 0.5, maxLife: 0.5, size: 6 + Math.random() * 6, color: Math.random() < 0.5 ? '#ff7043' : '#ffd54f',
        });
      }
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
    } else if (selfAg > 0) {
      els.ammoBox.textContent = '🚀 强化攻击就绪（下一发）';
      els.ammoBox.classList.remove('reloading');
    } else if (selfType === 'hj10') {
      els.ammoBox.textContent = '🚀 导弹 x' + localMag;
      els.ammoBox.classList.remove('reloading');
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
    // 特殊武器状态（并入玩家 HUD，不遮挡战场）：梅卡瓦迫击炮 / 99B 主动防御
    if (selfType === 'il') {
      els.wepBox.classList.remove('hidden');
      const ready = selfMortar <= 0;
      const cdPct = Math.round((1 - selfMortar / 30) * 100);
      if (mortarMode) {
        els.wepText.textContent = ready ? '💣 迫击炮就绪，开火！' : '💣 迫击炮冷却 ' + Math.ceil(selfMortar) + 's';
      } else {
        els.wepText.textContent = ready ? '💣 迫击炮就绪（按 2 切换）' : '💣 迫击炮冷却 ' + Math.ceil(selfMortar) + 's（按 2 切换）';
      }
      els.wepBar.firstChild.style.width = (ready ? 100 : cdPct) + '%';
      els.wepBar.firstChild.style.background = ready ? '#66bb6a' : '#ff5252';
      els.wepBox.style.borderColor = ready ? '#66bb6a' : '#ff5252';
    } else if (selfType === 'ru') {
      // T90A 窗帘干扰：干扰一次后冷却 20s（进度条）
      els.wepBox.classList.remove('hidden');
      if (selfShtoraCd > 0) {
        els.wepText.textContent = '📡 干扰冷却 ' + Math.ceil(selfShtoraCd) + 's';
        els.wepBar.firstChild.style.width = Math.round((1 - selfShtoraCd / 20) * 100) + '%';
        els.wepBar.firstChild.style.background = '#ff5252';
        els.wepBox.style.borderColor = '#ff5252';
      } else {
        els.wepText.textContent = '📡 反导干扰就绪（导弹进入前方扇形自动返回）';
        els.wepBar.firstChild.style.width = '100%';
        els.wepBar.firstChild.style.background = '#66bb6a';
        els.wepBox.style.borderColor = '#66bb6a';
      }
    } else if (selfType === 'de') {
      // 豹二A7 火控雷达：开启 30s 显示弹道+穿深50 / 冷却 5s
      els.wepBox.classList.remove('hidden');
      if (selfRadarT > 0) {
        els.wepText.textContent = '📡 火控雷达激活 ' + selfRadarT + 's（弹道可见，穿深+50）';
        els.wepBar.firstChild.style.width = Math.round(selfRadarT / 30 * 100) + '%';
        els.wepBar.firstChild.style.background = '#4dd0e1';
        els.wepBox.style.borderColor = '#4dd0e1';
      } else if (selfRadarCd > 0) {
        els.wepText.textContent = '📡 火控雷达冷却 ' + selfRadarCd + 's';
        els.wepBar.firstChild.style.width = Math.round((1 - selfRadarCd / 5) * 100) + '%';
        els.wepBar.firstChild.style.background = '#ff8a80';
        els.wepBox.style.borderColor = '#ff8a80';
      } else {
        els.wepText.textContent = '📡 火控雷达就绪（按 E 开启）';
        els.wepBar.firstChild.style.width = '100%';
        els.wepBar.firstChild.style.background = '#66bb6a';
        els.wepBox.style.borderColor = '#66bb6a';
      }
    } else if (selfType === 'cn') {
      els.wepBox.classList.remove('hidden');
      if (selfApsOn > 0) {
        els.wepText.textContent = '🛡️ 主动防御激活 ' + selfApsOn + 's';
        els.wepBar.firstChild.style.width = Math.round(selfApsOn / 10 * 100) + '%';
        els.wepBar.firstChild.style.background = '#4dd0e1';
        els.wepBox.style.borderColor = '#4dd0e1';
      } else if (selfApsCd > 0) {
        els.wepText.textContent = '🛡️ 主动防御冷却 ' + selfApsCd + 's';
        els.wepBar.firstChild.style.width = Math.round((1 - selfApsCd / 60) * 100) + '%';
        els.wepBar.firstChild.style.background = '#ff8a80';
        els.wepBox.style.borderColor = '#ff8a80';
      } else {
        els.wepText.textContent = '🛡️ 主动防御 x' + selfApsN + '（按 E 开启）';
        els.wepBar.firstChild.style.width = (selfApsN > 0 ? 100 : 0) + '%';
        els.wepBar.firstChild.style.background = '#fff';
        els.wepBox.style.borderColor = '#2a3a5c';
      }
    } else {
      els.wepBox.classList.add('hidden');
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
    const isHost = hostId === myId;
    for (const p of list) {
      const div = document.createElement('div');
      div.className = 'plrow' + (p.host ? ' host' : '');
      const color = PALETTE[hashId(p.id) % PALETTE.length];
      const tIcon = p.type === 'ru' ? '🇷🇺' : (p.type === 'jp' ? '🇯🇵' : (p.type === 'il' ? '🇮🇱' : (p.type === 'cn' || p.type === 'hj10' ? '🇨🇳' : (p.type === 'de' ? '🇪🇺' : '🇺🇸'))));
      div.innerHTML = '<span class="dot" style="background:' + color + '"></span>' + tIcon + ' ' +
        esc(p.name) + (p.host ? ' <span class="crown">👑</span>' : '') +
        (p.id === myId ? ' <span style="color:#4fc3f7;font-size:11px">(你)</span>' : '') +
        (p.alive ? '' : ' <span style="color:#7e92b8;font-size:11px">[观战中]</span>');
      // 房主踢人按钮（房主可见，不能踢自己和机器人）
      if (isHost && p.id !== myId && !p.bot) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'mini kick-btn';
        kickBtn.textContent = '踢出';
        kickBtn.addEventListener('click', () => {
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'kick', id: p.id }));
        });
        div.appendChild(kickBtn);
      }
      els.playerList.appendChild(div);
    }
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
  const TANK_INFO = {
    us: '<b>🇺🇸 美军 M1A1</b>　<span class="ti-spec">穿深800(反弹-100)｜装甲600/200/400｜爆反+300｜装填4s</span><br>⚠ 尾舱弹药架被击中必殉爆｜快移速快装填',
    ru: '<b>🇷🇺 俄军 T90A</b>　<span class="ti-spec">穿深800(反弹-200)｜装甲800/300/700｜爆反+500｜装填6s</span><br>📡 窗帘干扰：前方扇形导弹原路返回（干扰后冷却20s）｜侧面弹药架（爆反≥30%保护）',
    jp: '<b>🇯🇵 日军 90式</b>　<span class="ti-spec">穿深500(反弹+200)｜装甲550/150/250｜爆反+200｜装填3s</span><br>💥 反弹穿深递增最多9次｜尾舱殉爆+前置弹药架起火(50%)',
    il: '<b>🇮🇱 以军 梅卡瓦Mk4</b>　<span class="ti-spec">穿深550｜装甲600/250/450(发动机+200)｜爆反+200｜装填4.5s</span><br>🔧 发动机前置装甲加成｜弹药架只起火不殉爆｜炮塔坏连带起火｜💣 迫击炮(静止3s锁定扣30%爆反，1/2键切换)',
    cn: '<b>🇨🇳 中国 99B</b>　<span class="ti-spec">穿深900(反弹-50)｜装甲1000/150/650｜爆反+450｜装填5s</span><br>🛡️ 主动防御E(2次抵挡/60s恢复，炮塔坏失效)｜侧面弹药架必殉爆｜全场最快',
    de: '<b>🇪🇺 欧盟 豹二A7</b>　<span class="ti-spec">穿深800(反弹不扣)｜装甲600/200/400｜爆反+300｜装填5s</span><br>💥 反弹不扣穿深但仅2次｜尾舱殉爆+前置弹药架起火｜📡 火控雷达(E)：开启显示弹道+穿深50，30s/冷却5s',
    hj10: '<b>🇨🇳 中国 红箭10导弹车</b>　<span class="ti-spec">穿深2000打中就死｜装甲200/200/200｜无爆反｜装填15s(两连发)</span><br>🚀 给他们共和国震撼！让西方朋友上市！',
  };
  const tankInfoEl = document.getElementById('tankInfo');
  function showTankInfo(type) {
    if (tankInfoEl) tankInfoEl.innerHTML = TANK_INFO[type] || '';
  }
  function pickTank(type) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'pick', type }));
    els.tpUs.classList.toggle('sel-us', type === 'us');
    els.tpRu.classList.toggle('sel-ru', type === 'ru');
    if (els.tpJp) els.tpJp.classList.toggle('sel-jp', type === 'jp');
    if (els.tpIl) els.tpIl.classList.toggle('sel-il', type === 'il');
    if (els.tpCn) els.tpCn.classList.toggle('sel-cn', type === 'cn');
    if (els.tpHj) els.tpHj.classList.toggle('sel-cn', type === 'hj10');
    if (els.tpDe) els.tpDe.classList.toggle('sel-de', type === 'de');
    showTankInfo(type);
  }
  els.tpUs.addEventListener('click', () => pickTank('us'));
  els.tpRu.addEventListener('click', () => pickTank('ru'));
  if (els.tpJp) els.tpJp.addEventListener('click', () => pickTank('jp'));
  if (els.tpIl) els.tpIl.addEventListener('click', () => pickTank('il'));
  if (els.tpCn) els.tpCn.addEventListener('click', () => pickTank('cn'));
  if (els.tpHj) els.tpHj.addEventListener('click', () => pickTank('hj10'));
  if (els.tpDe) els.tpDe.addEventListener('click', () => pickTank('de'));
  showTankInfo('us'); // 默认展示美军介绍
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
    // 弹药本地模拟（单发制；红箭10 两连发：打一发留一发，打完才装填，服务器快照校正）
    localFireCd -= dt;
    if (localReload > 0) {
      localReload -= dt;
      if (localReload <= 0) localMag = (TANK_TYPES[selfType] && TANK_TYPES[selfType].mag) || MAG_SIZE;
    }
    const inpNow = currentInput();
    if (mortarLocalLock > 0) mortarLocalLock -= dt; // 本地迫击炮锁递减（30s）
    // 迫击炮模式：本地预测弹（穿墙、慢速），30s 冷却由服务器控制（mc）+ 本地锁双重限制
    if (phase === 'play' && selfAlive && selfParts.turret && mortarMode && inpNow.shoot && pred && localFireCd <= 0 && selfMortar <= 0 && mortarLocalLock <= 0) {
      localFireCd = 0.35; // 预测弹限频（服务器 30s 冷却为准）
      mortarLocalLock = 30; // 与服务器同步锁 30s
      const ta = autoTurret ? pred.a : mouseAngle;
      predBullets.push({
        x: pred.x + Math.cos(ta) * 34, y: pred.y + Math.sin(ta) * 34,
        vx: Math.cos(ta) * 340, vy: Math.sin(ta) * 340,
        pen: 100, t: performance.now(), isMortar: true,
      });
    }
    if (phase === 'play' && selfAlive && selfParts.turret && !mortarMode && inpNow.shoot && localFireCd <= 0 && localMag > 0) {
      localFireCd = 0.25;
      localMag = Math.max(0, localMag - 1); // 弹匣递减（红箭10 两连发）
      let reload = TANK_TYPES[selfType].reload;
      if (selfType === 'ru' && !selfParts.loader) reload *= 2; // 俄军装弹机损坏；美军无装弹机
      if (selfBuffs.rap > 0) reload *= 0.5;
      if (localMag === 0) localReload = reload; // 弹匣打空才开始装填
      // 本地子弹预测：立即显示自己发射的子弹（不等服务器往返），穿深与服务器一致
      if (pred) {
        const ta = autoTurret ? pred.a : mouseAngle;
        // 强化攻击（捡到导弹道具）：下一发自动变成强化导弹（慢速、长拖尾），本地模拟消耗
        if (selfAg > 0) {
          selfAg = 0;
          predBullets.push({
            x: pred.x + Math.cos(ta) * 34, y: pred.y + Math.sin(ta) * 34,
            vx: Math.cos(ta) * 260, vy: Math.sin(ta) * 260,
            pen: 1500, t: performance.now(),
            isAtgm: true, // 强化导弹：慢速直线、长拖尾（渲染与服务器一致）
          });
        } else {
          const hjt = TANK_TYPES[selfType] || TANK_TYPES.us;
          const spd = hjt.hjSpeed || 620;
          const tt = hjt;
          // 红箭10：左右发射箱交替发射（左箱一发、右箱一发，出生点侧向偏移）
          let ox = 0;
          if (hjt.instaKill) { localHjSide = localHjSide ? 0 : 1; ox = (localHjSide ? -1 : 1) * 7; }
          predBullets.push({
            x: pred.x + Math.cos(ta) * 34 - Math.sin(ta) * ox,
            y: pred.y + Math.sin(ta) * 34 + Math.cos(ta) * ox,
            vx: Math.cos(ta) * spd, vy: Math.sin(ta) * spd,
            pen: tt.pen, t: performance.now(),
            isHj: !!hjt.instaKill, // 红箭10：极快、不可反弹、撞墙消失
          });
          if (selfBuffs.trp > 0) {
            predBullets.push({ x: pred.x + Math.cos(ta - 0.18) * 34, y: pred.y + Math.sin(ta - 0.18) * 34, vx: Math.cos(ta - 0.18) * spd, vy: Math.sin(ta - 0.18) * spd, pen: tt.pen, t: performance.now() });
            predBullets.push({ x: pred.x + Math.cos(ta + 0.18) * 34, y: pred.y + Math.sin(ta + 0.18) * 34, vx: Math.cos(ta + 0.18) * spd, vy: Math.sin(ta + 0.18) * spd, pen: tt.pen, t: performance.now() });
          }
        }
      }
    }
    // 推进/清理本地预测子弹（反弹几何与服务器一致：普通扣穿深，90式反弹+100 穿深最多 9 次）
    const myTT = TANK_TYPES[selfType] || TANK_TYPES.us;
    const penDrop = myTT.penDrop || 100;
    const isJP = !!myTT.penGain;
    // 反弹穿深处理（与服务器 applyBouncePen 一致）；返回 true = 子弹消失
    const bouncePen = (pb) => {
      if (isJP) {
        pb.penBounces = (pb.penBounces || 0) + 1;
        pb.pen += myTT.penGain;
        return pb.penBounces >= myTT.penBounceMax;
      }
      if (myTT.penBounceMax && myTT.penDrop === 0) {
        // 豹二：反弹不扣穿深，最多 2 次
        pb.penBounces = (pb.penBounces || 0) + 1;
        return pb.penBounces >= myTT.penBounceMax;
      }
      pb.pen -= penDrop;
      return pb.pen <= 0;
    };
    for (let i = predBullets.length - 1; i >= 0; i--) {
      const pb = predBullets[i];
      const px0 = pb.x, py0 = pb.y;
      pb.x += pb.vx * dt;
      pb.y += pb.vy * dt;
      // 命中检测：敌方坦克 + 自己（反弹回来的炮弹会自伤，与服务器一致；players 里含自己）
      // 炮口 48 > 命中框半长 48，出生点必在框外，无需出生保护
      let hitTank = false;
      for (const p of players.values()) {
        if (!p.render) continue;
        // 出生保护：出膛 200ms 内不判定命中自己（斜射时炮口投影会落入命中框，否则斜射吞炮弹）
        if (p.id === myId && performance.now() - pb.t < 200) continue;
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
      // 世界墙反弹（与服务器同：反弹扣穿深，扣完消失；迫击炮弹穿墙；红箭10/强化导弹撞墙消失）
      let bounced = false;
      if ((pb.isHj || pb.isAtgm) && (pb.x < WALL_T || pb.x > WORLD.w - WALL_T || pb.y < WALL_T || pb.y > WORLD.h - WALL_T)) { predBullets.splice(i, 1); continue; }
      if (!pb.isMortar && !pb.isHj && pb.x < WALL_T + 5) { pb.x = WALL_T + 5; pb.vx = -pb.vx; bounced = true; }
      else if (!pb.isMortar && !pb.isHj && pb.x > WORLD.w - WALL_T - 5) { pb.x = WORLD.w - WALL_T - 5; pb.vx = -pb.vx; bounced = true; }
      if (!bounced && !pb.isMortar && !pb.isHj && pb.y < WALL_T + 5) { pb.y = WALL_T + 5; pb.vy = -pb.vy; bounced = true; }
      else if (!bounced && !pb.isMortar && !pb.isHj && pb.y > WORLD.h - WALL_T - 5) { pb.y = WORLD.h - WALL_T - 5; pb.vy = -pb.vy; bounced = true; }
      // 障碍反弹：线段检测（与服务器 segRectHit 一致，反弹轨迹完整；迫击炮弹穿墙；红箭10/强化导弹撞墙消失）
      if (!bounced && !pb.isMortar && !pb.isHj && !pb.isAtgm) {
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
        if (bouncePen(pb)) { predBullets.splice(i, 1); continue; }
      }
      // 兜底：子弹中心进入障碍内部（反弹后贴墙/擦角）→ 按最近表面推出（与服务器一致，杜绝穿墙；迫击炮跳过；红箭10/强化导弹撞墙消失）
      if (!bounced && !pb.isMortar) {
        for (const o of mapObstacles) {
          if (pb.x > o.x && pb.x < o.x + o.w && pb.y > o.y && pb.y < o.y + o.h) {
            if (pb.isHj || pb.isAtgm) { predBullets.splice(i, 1); break; } // 撞墙消失
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
              if (bouncePen(pb)) { predBullets.splice(i, 1); continue; }
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
    // 子弹插值状态维护（id 匹配：更新目标位置，删除消失子弹）
    const seenB = new Set();
    for (const b of bullets) {
      seenB.add(b.i);
      const rs = bulletRenders.get(b.i);
      if (rs) { rs.tx = b.x; rs.ty = b.y; rs.tvx = b.vx; rs.tvy = b.vy; }
      else bulletRenders.set(b.i, { x: b.x, y: b.y, vx: b.vx, vy: b.vy, tx: b.x, ty: b.y, tvx: b.vx, tvy: b.vy });
    }
    for (const id of bulletRenders.keys()) if (!seenB.has(id)) bulletRenders.delete(id);
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
        p.render = { x: selfPos.x, y: selfPos.y, a: selfPos.a, ta: autoTurret ? selfPos.a : mouseAngle, hp: selfHp, shd: selfBuffs.shd, ty: selfType, prt: [selfParts.track, selfParts.turret, selfParts.engine, selfParts.ammo, selfParts.optics, selfParts.loader], fr: selfFire, am: selfAmFire ? 1 : 0, mc: selfMortar, ag: selfAg, jm: selfJm ? 1 : 0 };
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
          am: to.am || 0,
          ty: to.ty || 'us',
          mc: to.mc || 0,
          ag: to.ag || 0,
          jm: to.jm || 0,
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

  // ---------------- 布局设置（按键/小地图位置大小，localStorage 持久化，供安卓 App 使用） ----------------
  const LAYOUT_KEY = 'tank.gameLayout.v1';
  const LAYOUT_DEFAULT = {
    dpad: { l: 14, b: 14, s: 54 },   // 十字键：left/bottom/键大小
    fire: { r: 14, t: 122, s: 66 },  // 开火键：right/top/直径
    boost: { r: 14, t: 76, s: 52 },  // 加速键
    map: { r: 12, t: 8, s: 78 },     // 小地图：right/top/宽
  };
  const LAYOUT_EL = { dpad: 'dpad', fire: 'btnFire', boost: 'boostBtn', map: 'minimap' };
  let layout = loadLayout();
  let layoutSel = 'dpad';
  let layoutEdit = false;
  let drag = null;

  function loadLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        const L = {};
        for (const k of Object.keys(LAYOUT_DEFAULT)) L[k] = Object.assign({}, LAYOUT_DEFAULT[k], o[k] || {});
        return L;
      }
    } catch (e) { /* 数据损坏回退默认 */ }
    return JSON.parse(JSON.stringify(LAYOUT_DEFAULT));
  }
  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (e) {}
  }
  function applyLayout() {
    const dp = document.getElementById('dpad');
    if (dp) {
      dp.style.left = layout.dpad.l + 'px';
      dp.style.bottom = layout.dpad.b + 'px';
      dp.style.gridTemplateColumns = 'repeat(3, ' + layout.dpad.s + 'px)';
      dp.style.gridTemplateRows = 'repeat(3, ' + layout.dpad.s + 'px)';
    }
    const fb = document.getElementById('btnFire');
    if (fb) {
      fb.style.right = layout.fire.r + 'px';
      fb.style.top = layout.fire.t + 'px';
      fb.style.width = layout.fire.s + 'px';
      fb.style.height = layout.fire.s + 'px';
      fb.style.fontSize = Math.max(14, Math.round(layout.fire.s * 0.32)) + 'px';
    }
    const bb = document.getElementById('boostBtn');
    if (bb) {
      bb.style.right = layout.boost.r + 'px';
      bb.style.top = layout.boost.t + 'px';
      bb.style.width = layout.boost.s + 'px';
      bb.style.height = layout.boost.s + 'px';
    }
    const mmEl = document.getElementById('minimap');
    if (mmEl) {
      mmEl.style.right = layout.map.r + 'px';
      mmEl.style.top = layout.map.t + 'px';
      mmEl.style.width = layout.map.s + 'px';
      mmEl.style.height = Math.round(layout.map.s * 111 / 148) + 'px';
    }
  }
  function enterLayoutEdit() {
    layoutEdit = true;
    document.body.classList.add('layout-edit');
    const p = document.getElementById('layoutPanel');
    if (p) p.classList.remove('hidden');
    updateSelUI();
  }
  function exitLayoutEdit() {
    layoutEdit = false;
    document.body.classList.remove('layout-edit');
    const p = document.getElementById('layoutPanel');
    if (p) p.classList.add('hidden');
  }
  function updateSelUI() {
    const sizeEl = document.getElementById('lpSize');
    const valEl = document.getElementById('lpSizeVal');
    if (sizeEl) sizeEl.value = String(layout[layoutSel].s);
    if (valEl) valEl.textContent = layout[layoutSel].s;
    document.querySelectorAll('.lpSel').forEach((b) => b.classList.toggle('active', b.dataset.lp === layoutSel));
  }
  // 拖动（捕获阶段，避免与开火键/十字键的原有绑定冲突）
  document.addEventListener('pointerdown', (e) => {
    if (!layoutEdit) return;
    const tgt = document.getElementById(LAYOUT_EL[layoutSel]);
    if (!tgt) return;
    const rect = tgt.getBoundingClientRect();
    if (e.clientX >= rect.left - 12 && e.clientX <= rect.right + 12 && e.clientY >= rect.top - 12 && e.clientY <= rect.bottom + 12) {
      e.preventDefault();
      e.stopPropagation();
      drag = { offX: e.clientX - rect.left, offY: e.clientY - rect.top };
      try { tgt.setPointerCapture(e.pointerId); } catch (err) {}
    }
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!layoutEdit || !drag) return;
    e.preventDefault();
    const vw = window.innerWidth, vh = window.innerHeight;
    const tgt = document.getElementById(LAYOUT_EL[layoutSel]);
    if (!tgt) return;
    const rect = tgt.getBoundingClientRect();
    const left = Math.max(0, Math.min(vw - rect.width, e.clientX - drag.offX));
    const top = Math.max(0, Math.min(vh - rect.height, e.clientY - drag.offY));
    if (layoutSel === 'dpad') { layout.dpad.l = Math.round(left); layout.dpad.b = Math.round(vh - top - rect.height); }
    else if (layoutSel === 'fire') { layout.fire.r = Math.round(vw - left - rect.width); layout.fire.t = Math.round(top); }
    else if (layoutSel === 'boost') { layout.boost.r = Math.round(vw - left - rect.width); layout.boost.t = Math.round(top); }
    else if (layoutSel === 'map') { layout.map.r = Math.round(vw - left - rect.width); layout.map.t = Math.round(top); }
    applyLayout();
  });
  document.addEventListener('pointerup', () => { drag = null; });
  document.addEventListener('pointercancel', () => { drag = null; });
  // 面板交互
  const lpPanel = document.getElementById('layoutPanel');
  if (lpPanel) {
    lpPanel.addEventListener('click', (e) => {
      const sel = e.target.closest && e.target.closest('.lpSel');
      if (sel) { layoutSel = sel.dataset.lp; updateSelUI(); return; }
      if (e.target.id === 'lpSave') { saveLayout(); exitLayoutEdit(); return; }
      if (e.target.id === 'lpReset') { layout = JSON.parse(JSON.stringify(LAYOUT_DEFAULT)); applyLayout(); updateSelUI(); return; }
      if (e.target.id === 'lpClose') { layout = loadLayout(); applyLayout(); exitLayoutEdit(); return; }
    });
  }
  const sizeEl = document.getElementById('lpSize');
  if (sizeEl) {
    sizeEl.addEventListener('input', () => {
      layout[layoutSel].s = parseInt(sizeEl.value, 10) || 54;
      const valEl = document.getElementById('lpSizeVal');
      if (valEl) valEl.textContent = layout[layoutSel].s;
      applyLayout();
    });
  }
  const btnLayout = document.getElementById('btnLayout');
  if (btnLayout) btnLayout.addEventListener('click', enterLayoutEdit);
  const btnLayoutGame = document.getElementById('btnLayoutGame');
  if (btnLayoutGame) btnLayoutGame.addEventListener('click', enterLayoutEdit);
  applyLayout();

  // 布局设置自测（?layouttest=1 时运行，输出到 #layoutTestOut，供 headless 验证）
  if (typeof URLSearchParams !== 'undefined' && new URLSearchParams(location.search).get('layouttest') === '1') {
    setTimeout(() => {
      const res = [];
      const ok = (n, c, e) => res.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' -- ' + e : ''));
      try {
        const btn = document.getElementById('btnLayout');
        const panel = document.getElementById('layoutPanel');
        ok('布局按钮存在', !!btn);
        btn.click();
        ok('进入编辑模式', document.body.classList.contains('layout-edit'));
        ok('面板显示', panel && !panel.classList.contains('hidden'));
        const selMap = document.querySelector('.lpSel[data-lp="map"]');
        selMap.click();
        ok('选中小地图', layoutSel === 'map');
        const sizeEl = document.getElementById('lpSize');
        sizeEl.value = '100';
        sizeEl.dispatchEvent(new Event('input'));
        ok('滑块调大小生效', layout.map.s === 100);
        const mmEl = document.getElementById('minimap');
        ok('小地图尺寸应用', mmEl.style.width === '100px', mmEl.style.width);
        document.getElementById('lpSave').click();
        const saved = JSON.parse(localStorage.getItem('tank.gameLayout.v1'));
        ok('保存到 localStorage', !!saved && saved.map && saved.map.s === 100);
        btn.click();
        document.querySelector('.lpSel[data-lp="map"]').click();
        document.getElementById('lpReset').click();
        ok('恢复默认', layout.map.s === 78 && layout.dpad.s === 54);
        document.getElementById('lpClose').click();
        ok('关闭面板', panel.classList.contains('hidden'));
        ok('退出编辑模式', !document.body.classList.contains('layout-edit'));
        // 模拟拖动小地图（pointer 事件）
        btn.click();
        document.querySelector('.lpSel[data-lp="map"]').click();
        const mmEl2 = document.getElementById('minimap');
        const rr = mmEl2.getBoundingClientRect();
        const beforeR = layout.map.r, beforeT = layout.map.t;
        if (typeof PointerEvent !== 'undefined') {
          document.dispatchEvent(new PointerEvent('pointerdown', { clientX: rr.left + 10, clientY: rr.top + 10, pointerId: 7, bubbles: true, cancelable: true }));
          document.dispatchEvent(new PointerEvent('pointermove', { clientX: rr.left + 140, clientY: rr.top + 80, pointerId: 7, bubbles: true, cancelable: true }));
          document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true, cancelable: true }));
          ok('拖动改变小地图位置', layout.map.r !== beforeR || layout.map.t !== beforeT, 'r=' + layout.map.r + ' t=' + layout.map.t);
        } else {
          ok('PointerEvent 可用', false, 'unsupported');
        }
        document.getElementById('lpClose').click();
      } catch (e) { res.push('FAIL exception -- ' + e.message); }
      const out = document.createElement('pre');
      out.id = 'layoutTestOut';
      out.textContent = res.join('\n') + '\n' + (res.every((r) => r.startsWith('PASS')) ? 'ALL PASS' : 'HAS FAILURES');
      document.body.appendChild(out);
      try {
        fetch('http://127.0.0.1:8125/report', {
          method: 'POST', mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ layout: res.join('|'), pass: res.every((r) => r.startsWith('PASS')) }),
        }).catch(() => {});
      } catch (e) {}
    }, 600);
  }

  // ---------------- 启动 ----------------
  showMenu();
  resize();
  requestAnimationFrame(loop);
  window.__gameBooted = true; // boot 完成标记（测试/调试用）
})();
