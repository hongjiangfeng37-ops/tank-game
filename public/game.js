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
  // 迷宫由服务器每回合随机生成并通过 map 消息下发；初始为简单占位布局
  let mapObstacles = [
    { x: 330, y: 240, w: 240, h: 150 },
    { x: 1030, y: 240, w: 240, h: 150 },
    { x: 330, y: 810, w: 240, h: 150 },
    { x: 1030, y: 810, w: 240, h: 150 },
    { x: 700, y: 525, w: 200, h: 150 },
  ];
  const TANK = { r: 22, maxSpeed: 240, accel: 340, back: 0.62, turn: 3.2, dragF: 0.9, dragL: 3.8, hp: 100, boostMult: 1.3 };
  const MAG_SIZE = 6;       // 弹匣容量（与 server.js 一致）
  const RELOAD_TIME = 1.4;  // 换弹时间（与 server.js 一致）
  const PALETTE = ['#ff5d5d', '#4fc3f7', '#66bb6a', '#ffee58', '#ff8a65', '#ba68c8', '#4dd0e1', '#f06292', '#aed581', '#90a4ae'];
  const PUP_COLOR = { health: '#4caf50', shield: '#4dd0e1', rapid: '#ffca28', triple: '#ff7043' };
  const PUP_ICON = { health: '回血', shield: '护盾', rapid: '速射', triple: '三连' };
  const INTERP_MS = 30; // 快照插值延迟（60Hz 快照下 30ms 足够平滑，进一步降低感知延迟）

  // ---------------- DOM ----------------
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const mm = $('minimap');
  const mmCtx = mm.getContext('2d');
  const els = {
    topbar: $('topbar'), codeText: $('codeText'), btnCopy: $('btnCopy'),
    pingText: $('pingText'), btnMute: $('btnMute'), btnLeave: $('btnLeave'), btnPub: $('btnPub'),
    countdown: $('countdown'), banner: $('banner'), killfeed: $('killfeed'),
    hud: $('hud'), hpBar: $('hpBar'), hpText: $('hpText'), ammoBox: $('ammoBox'), buffs: $('buffs'),
    partTrack: $('part-track'), partTurret: $('part-turret'), partEngine: $('part-engine'),
    partAmmo: $('part-ammo'), partOptics: $('part-optics'),
    repairBar: $('repairBar'), damageNote: $('damageNote'),
    deathOverlay: $('deathOverlay'), deathText: $('deathText'),
    scoreboard: $('scoreboard'), sbRows: $('sbRows'),
    menu: $('menu'), nameInput: $('nameInput'), btnCreate: $('btnCreate'),
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
  let selfParts = { track: true, turret: true, engine: true, ammo: true, optics: true }; // 本地部件状态
  let selfRepair = 0;           // 维修进度(秒)
  let selfFire = 0;             // 起火剩余秒数

  const keys = {};
  const mouse = { x: 0, y: 0, down: false, active: false };
  let mouseAngle = 0;
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
    intent = browse ? { join: false, room: null } : { join: true, room: room || null };
    intentionalClose = false;
    if (!browse) { // 浏览模式(房间列表扫描)是静默连接，不显示遮罩
      show(els.connOverlay, true);
      show(els.btnConnCancel, reconnectTimer != null);
      els.connText.textContent = '连接中…';
    }
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    try { ws = new WebSocket(proto + location.host + '/ws'); } catch (e) { onConnFail('无法连接服务器'); return; }
    ws.onopen = () => {
      if (intent.join) ws.send(JSON.stringify({ t: 'join', name: myName, room: intent.room }));
      else { ws.send(JSON.stringify({ t: 'list' })); startBrowse(); }
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleMsg(m);
    };
    ws.onclose = () => {
      ws = null;
      stopBrowse();
      if (intentionalClose) { showMenu(); return; }
      if (browse) { // 静默重连浏览连接
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(null, { browse: true }); }, 3000);
        return;
      }
      els.connText.textContent = '连接断开，正在重连…';
      show(els.connOverlay, true);
      show(els.btnConnCancel, true);
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(room, opts); }, 1800);
    };
    ws.onerror = () => { /* onclose 处理 */ };
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
      selfRepair = me.rp || 0;
      selfFire = me.fr || 0;
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
          if (e.id === myId) zoneNote(e.zone, e.parts);
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
  function zoneNote(zone, parts) {
    const zname = { front: '正面命中', side: '侧面命中', back: '背面命中' }[zone] || '命中';
    const pnames = (parts || []).map((p) => ({ track: '履带', turret: '炮塔', engine: '发动机', ammo: '弹药架', optics: '观瞄' }[p] || p)).join('、');
    showDamageNote(pnames ? zname + '！' + pnames + ' 损坏' : zname + '！', false);
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
    if (e.target === canvas) { mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true; }
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
    let ta = mouseAngle;
    let shoot = mouse.down || keys.Space;
    let boost = !!(keys.ShiftLeft || keys.ShiftRight);
    if (touch.mode) {
      // 十字方向键移动（固定 UI，量化 ±1）
      thr = clamp(thr + ((dpad.up ? 1 : 0) - (dpad.down ? 1 : 0)), -1, 1);
      steer = clamp(steer + ((dpad.right ? 1 : 0) - (dpad.left ? 1 : 0)), -1, 1);
      if (touch.aim) {
        const len = Math.hypot(touch.aim.dx, touch.aim.dy);
        if (len > 8) ta = Math.atan2(touch.aim.dy, touch.aim.dx);
        shoot = true; // 按住右摇杆即开火
      }
      if (touch.boost) boost = true;
      if (fireHeld) shoot = true; // 独立开火键
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
    tk.ta = mouseAngle;
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

  function drawTank(p, now) {
    const t = p.render;
    const color = p.color;
    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(t.x, t.y + 5, 26, 20, t.a, 0, Math.PI * 2); ctx.fill();
    // 车体
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.a);
    // 履带（损坏时颜色变暗）
    ctx.fillStyle = t.prt && !t.prt[0] ? '#3d322b' : '#20293a';
    rr(-24, -17, 48, 11, 4); ctx.fill();
    rr(-24, 6, 48, 11, 4); ctx.fill();
    if (t.prt && t.prt[0]) {
      ctx.strokeStyle = '#2e3b52';
      ctx.lineWidth = 1.5;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath(); ctx.moveTo(i * 8, -16.5); ctx.lineTo(i * 8, -7.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(i * 8, 7.5); ctx.lineTo(i * 8, 16.5); ctx.stroke();
      }
    } else {
      // 履带断裂效果
      ctx.strokeStyle = '#5a4633';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-10, -12); ctx.lineTo(6, -12); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2, 11); ctx.lineTo(18, 11); ctx.stroke();
    }
    // 车身
    ctx.fillStyle = color;
    rr(-19, -13, 38, 26, 6); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    rr(-19, -13, 38, 26, 6); ctx.fill(); // 阴影叠层(简化)
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1.5;
    rr(-19, -13, 38, 26, 6); ctx.stroke();
    // 车头
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(19, -7); ctx.lineTo(25, 0); ctx.lineTo(19, 7);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    // 炮塔（损坏时炮管歪斜）
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.ta + (t.prt && !t.prt[1] ? 0.5 : 0));
    ctx.fillStyle = '#39445c';
    rr(8, -3.5, 26, 7, 3); ctx.fill();
    ctx.fillStyle = '#d8dee9';
    ctx.fillRect(30, -2, 5, 4);
    ctx.restore();
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(t.x, t.y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.arc(t.x, t.y, 4, 0, Math.PI * 2); ctx.fill();
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
    draw(touch.aim, '瞄准开火');
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
      mmCtx.fillStyle = p.id === myId ? '#ffffff' : (players.get(p.id) || {}).color || '#888';
      mmCtx.beginPath();
      mmCtx.arc(p.x * sx, p.y * sy, p.alive ? 3 : 2, 0, Math.PI * 2);
      mmCtx.fill();
    }
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
    // 弹药显示
    if (localReload > 0) {
      els.ammoBox.textContent = '装填中 ' + Math.ceil(localReload) + 's';
      els.ammoBox.classList.add('reloading');
    } else {
      els.ammoBox.textContent = '🔫 ' + localMag + '/' + MAG_SIZE;
      els.ammoBox.classList.remove('reloading');
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
      div.innerHTML = '<span class="dot" style="background:' + color + '"></span>' +
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
  function joinRoom(room) {
    myName = els.nameInput.value.trim().slice(0, 12) || ('玩家' + Math.floor(100 + Math.random() * 900));
    localStorage.setItem('tk_name', myName);
    els.errMsg.textContent = '';
    if (ws && ws.readyState === 1) {
      if (!joined) ws.send(JSON.stringify({ t: 'join', name: myName, room: room || null }));
    } else if (ws && ws.readyState === 0) {
      intent = { join: true, room: room || null }; // 连接建立后自动加入
    } else {
      connect(room);
    }
  }
  els.btnCreate.addEventListener('click', () => joinRoom(null));
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
    // 输入发送 / 本地预测
    resize();
    sendInput(now);
    // 弹药本地模拟（开火即时扣减，服务器快照校正）
    localFireCd -= dt;
    if (localReload > 0) {
      localReload -= dt;
      if (localReload <= 0) localMag = MAG_SIZE;
    }
    const inpNow = currentInput();
    if (phase === 'play' && selfAlive && selfParts.turret && inpNow.shoot && localFireCd <= 0 && localMag > 0) {
      localFireCd = selfBuffs.rap > 0 ? 0.14 : 0.35;
      localMag--;
      if (localMag <= 0) localReload = RELOAD_TIME;
      // 本地子弹预测：立即显示自己发射的子弹（不等服务器往返）
      if (pred) {
        const ta = mouseAngle;
        const spd = 620;
        predBullets.push({
          x: pred.x + Math.cos(ta) * 34, y: pred.y + Math.sin(ta) * 34,
          vx: Math.cos(ta) * spd, vy: Math.sin(ta) * spd,
          t: performance.now(),
        });
        if (selfBuffs.trp > 0) {
          predBullets.push({ x: pred.x + Math.cos(ta - 0.18) * 34, y: pred.y + Math.sin(ta - 0.18) * 34, vx: Math.cos(ta - 0.18) * spd, vy: Math.sin(ta - 0.18) * spd, t: performance.now() });
          predBullets.push({ x: pred.x + Math.cos(ta + 0.18) * 34, y: pred.y + Math.sin(ta + 0.18) * 34, vx: Math.cos(ta + 0.18) * spd, vy: Math.sin(ta + 0.18) * spd, t: performance.now() });
        }
      }
    }
    // 推进/清理本地预测子弹（1.2 秒后服务器快照已接管；含简化反弹避免穿墙视觉）
    for (let i = predBullets.length - 1; i >= 0; i--) {
      const pb = predBullets[i];
      pb.x += pb.vx * dt;
      pb.y += pb.vy * dt;
      // 世界墙反弹
      if (pb.x < WALL_T + 5) { pb.x = WALL_T + 5; pb.vx = -pb.vx; }
      else if (pb.x > WORLD.w - WALL_T - 5) { pb.x = WORLD.w - WALL_T - 5; pb.vx = -pb.vx; }
      if (pb.y < WALL_T + 5) { pb.y = WALL_T + 5; pb.vy = -pb.vy; }
      else if (pb.y > WORLD.h - WALL_T - 5) { pb.y = WORLD.h - WALL_T - 5; pb.vy = -pb.vy; }
      // 障碍反弹（简化 AABB，服务器会校正）
      for (const o of mapObstacles) {
        if (pb.x > o.x - 5 && pb.x < o.x + o.w + 5 && pb.y > o.y - 5 && pb.y < o.y + o.h + 5) {
          if (pb.vx > 0 && pb.x < o.x) { pb.x = o.x - 5; pb.vx = -pb.vx; }
          else if (pb.vx < 0 && pb.x > o.x + o.w) { pb.x = o.x + o.w + 5; pb.vx = -pb.vx; }
          else if (pb.vy > 0 && pb.y < o.y) { pb.y = o.y - 5; pb.vy = -pb.vy; }
          else if (pb.vy < 0 && pb.y > o.y + o.h) { pb.y = o.y + o.h + 5; pb.vy = -pb.vy; }
          break;
        }
      }
      if (performance.now() - pb.t > 1200) predBullets.splice(i, 1);
    }
    sendPing(now);
    stepPred(dt);

    // 鼠标世界角度
    if (mouse.active) {
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
        p.render = { x: selfPos.x, y: selfPos.y, a: selfPos.a, ta: mouseAngle, hp: selfHp, shd: selfBuffs.shd, prt: [selfParts.track, selfParts.turret, selfParts.engine, selfParts.ammo, selfParts.optics], fr: selfFire };
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
          prt: to.prt || [true, true, true, true, true],
          fr: to.fr || 0,
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
    if (selfParts.optics) drawMinimap(sa);

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

  // ---------------- 启动 ----------------
  showMenu();
  resize();
  requestAnimationFrame(loop);
})();
