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
  const OBSTACLES = [
    { x: 330, y: 240, w: 240, h: 150 },
    { x: 1030, y: 240, w: 240, h: 150 },
    { x: 330, y: 810, w: 240, h: 150 },
    { x: 1030, y: 810, w: 240, h: 150 },
    { x: 700, y: 525, w: 200, h: 150 },
  ];
  const TANK = { r: 22, maxSpeed: 240, accel: 340, back: 0.62, turn: 3.2, dragF: 0.9, dragL: 3.8, hp: 100, boostMult: 1.3 };
  const PALETTE = ['#ff5d5d', '#4fc3f7', '#66bb6a', '#ffee58', '#ff8a65', '#ba68c8', '#4dd0e1', '#f06292', '#aed581', '#90a4ae'];
  const PUP_COLOR = { health: '#4caf50', shield: '#4dd0e1', rapid: '#ffca28', triple: '#ff7043' };
  const PUP_ICON = { health: '回血', shield: '护盾', rapid: '速射', triple: '三连' };
  const INTERP_MS = 60; // 快照插值延迟（60Hz 快照下更低延迟）

  // ---------------- DOM ----------------
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const mm = $('minimap');
  const mmCtx = mm.getContext('2d');
  const els = {
    topbar: $('topbar'), codeText: $('codeText'), btnCopy: $('btnCopy'),
    pingText: $('pingText'), btnMute: $('btnMute'), btnLeave: $('btnLeave'), btnPub: $('btnPub'),
    countdown: $('countdown'), banner: $('banner'), killfeed: $('killfeed'),
    hud: $('hud'), hpBar: $('hpBar'), hpText: $('hpText'), buffs: $('buffs'),
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
    move: null, // {id, sx, sy, dx, dy}
    aim: null,
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
        case 'kill':
          sfx.kill();
          addKillfeed(e.killer, e.victim);
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
  function addKillfeed(killer, victim) {
    const div = document.createElement('div');
    div.className = 'kf';
    if (killer) div.innerHTML = '<b>' + esc(killer) + '</b> 击毁 <i>' + esc(victim) + '</i>';
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

  // 触屏双摇杆：原生 touch 事件驱动（iOS/Android 最可靠，避免 pointerup 丢失导致摇杆不消失）
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const x = t.clientX, y = t.clientY;
      if (x < canvas.clientWidth * 0.5) {
        if (!touch.move) touch.move = { id: t.identifier, sx: x, sy: y, dx: 0, dy: 0, at: Date.now() };
      } else if (!touch.aim) {
        touch.aim = { id: t.identifier, sx: x, sy: y, dx: 0, dy: 0, at: Date.now() };
      }
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const j = (touch.move && touch.move.id === t.identifier) ? touch.move : (touch.aim && touch.aim.id === t.identifier ? touch.aim : null);
      if (!j) continue;
      let dx = t.clientX - j.sx, dy = t.clientY - j.sy;
      const len = Math.hypot(dx, dy);
      if (len > JOY_R) { dx = dx / len * JOY_R; dy = dy / len * JOY_R; }
      j.dx = dx; j.dy = dy;
      j.at = Date.now();
      if (j === touch.aim && len > 8) mouseAngle = Math.atan2(dy, dx);
    }
  }, { passive: false });
  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (touch.move && touch.move.id === t.identifier) touch.move = null;
      if (touch.aim && touch.aim.id === t.identifier) touch.aim = null;
    }
  };
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);
  // 摇杆超时兜底：任何原因导致抬起事件丢失，2 秒无操作自动清除，杜绝"不消失"
  setInterval(() => {
    const t = Date.now();
    if (touch.move && t - touch.move.at > 2000) touch.move = null;
    if (touch.aim && t - touch.aim.at > 2000) touch.aim = null;
  }, 500);

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
      if (touch.move) {
        thr = clamp(thr + (-touch.move.dy / JOY_R), -1, 1);
        steer = clamp(steer + touch.move.dx / JOY_R, -1, 1);
      }
      if (touch.aim) {
        const len = Math.hypot(touch.aim.dx, touch.aim.dy);
        if (len > 8) ta = Math.atan2(touch.aim.dy, touch.aim.dx);
        shoot = true; // 按住右摇杆即开火
      }
      if (touch.boost) boost = true;
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
    const thr = inp.thr * (inp.thr < 0 ? TANK.back : 1);
    tk.vx += f.x * thr * TANK.accel * dt;
    tk.vy += f.y * thr * TANK.accel * dt;
    let fwd = tk.vx * f.x + tk.vy * f.y;
    let lat = tk.vx * px + tk.vy * py;
    const dragF = inp.thr !== 0 ? TANK.dragF : 1.7;
    fwd *= Math.exp(-dragF * dt);
    lat *= Math.exp(-TANK.dragL * dt);
    tk.vx = f.x * fwd + px * lat;
    tk.vy = f.y * fwd + py * lat;
    const spd = TANK.maxSpeed * (inp.boost ? TANK.boostMult : 1);
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
    for (const o of OBSTACLES) {
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
      camTarget.s = Math.max(0.7, Math.min(vw / 1000, vh / 760));
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
    for (const o of OBSTACLES) {
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
    // 子弹
    for (const b of bullets) {
      const tx = b.x - b.vx * 0.045, ty = b.y - b.vy * 0.045;
      ctx.strokeStyle = 'rgba(255, 210, 110, 0.55)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = '#fff3cf';
      ctx.beginPath(); ctx.arc(b.x, b.y, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255, 200, 90, 0.35)';
      ctx.beginPath(); ctx.arc(b.x, b.y, 7.5, 0, Math.PI * 2); ctx.fill();
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
    // 履带
    ctx.fillStyle = '#20293a';
    rr(-24, -17, 48, 11, 4); ctx.fill();
    rr(-24, 6, 48, 11, 4); ctx.fill();
    ctx.strokeStyle = '#2e3b52';
    ctx.lineWidth = 1.5;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath(); ctx.moveTo(i * 8, -16.5); ctx.lineTo(i * 8, -7.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(i * 8, 7.5); ctx.lineTo(i * 8, 16.5); ctx.stroke();
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
    // 炮塔
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.ta);
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
    // 血条 & 名字
    const bw = 46;
    const hpFrac = clamp(t.hp / 100, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    rr(t.x - bw / 2 - 1, t.y - 40, bw + 2, 7, 3); ctx.fill();
    ctx.fillStyle = hpFrac > 0.5 ? '#66bb6a' : hpFrac > 0.25 ? '#ffca28' : '#ff5d5d';
    rr(t.x - bw / 2, t.y - 39, bw * hpFrac, 5, 2.5); ctx.fill();
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = p.id === myId ? '#fff' : 'rgba(220,230,250,0.9)';
    ctx.fillText(p.name, t.x, t.y - 46);
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
    draw(touch.move, '移动');
    draw(touch.aim, '瞄准开火');
    if (!touch.move && !touch.aim) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath(); ctx.arc(95, vh - 105, 40, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(vw - 95, vh - 105, 40, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🕹 移动', 95, vh - 100);
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
    for (const o of OBSTACLES) mmCtx.fillRect(o.x * sx, o.y * sy, o.w * sx, o.h * sy);
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
        p.render = { x: selfPos.x, y: selfPos.y, a: selfPos.a, ta: mouseAngle, hp: selfHp, shd: selfBuffs.shd };
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
    if (!touch.mode) drawMinimap(sa); // 触屏模式小地图被 CSS 隐藏，跳过绘制

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
