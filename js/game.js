// ========== 掌合节奏 Palm Beat · 主程序 ==========
import { clamp, lerp, easeOutCubic, midiToFreq, store, roundRect, median } from './util.js';
import { buildChart, buildCalibrationChart, DIFFICULTY } from './chart.js';
import { MusicEngine, createAudioContext } from './audio.js';
import { HandTracker } from './hands.js';

const LANES = [
  { name: '左手', color: '#45e6ff', rgb: '69,230,255' },
  { name: '右手', color: '#ff5fd2', rgb: '255,95,210' },
];

const WINDOW = { perfect: 0.075, good: 0.145, ok: 0.2, miss: 0.205 };
const KEY_LATENCY = 0.04;
const SCORE = { perfect: 300, good: 200, ok: 100 };
const ACC = { perfect: 1, good: 0.72, ok: 0.34, miss: 0 };
const JCOLOR = { perfect: '#9df6ff', good: '#b7ff9c', ok: '#ffd98a', miss: '#ff8095' };

const $ = (sel) => document.querySelector(sel);

class Game {
  constructor() {
    this.canvas = $('#stage');
    this.ctx = this.canvas.getContext('2d');
    this.video = $('#cam');

    this.settings = {
      difficulty: store.get('difficulty', 'normal'),
      latency: store.get('latency', 0.12),
      preview: store.get('preview', true),
      guide: store.get('guide', true),
      swap: store.get('swap', false),
      keyboardOnly: store.get('keyboardOnly', false),
    };
    if (!DIFFICULTY[this.settings.difficulty]) this.settings.difficulty = 'normal';

    this.state = 'menu';
    this.S = 0;
    this.menuTime = 0;
    this.lastFrame = 0;
    this.particles = [];
    this.rings = [];
    this.judges = [];
    this.active = [];
    this.notePtr = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.stats = { perfect: 0, good: 0, ok: 0, miss: 0 };
    this.judgeCount = 0;
    this.accSum = 0;
    this.flash = 0;
    this.laneFlash = [0, 0];
    this.keyQueue = [];
    this.hudCache = {};
    this.calib = null;

    this.demo = buildChart({ difficulty: 'normal', seed: 424242 });

    this.tracker = new HandTracker({
      video: this.video,
      onStatus: (msg) => this.setCamStatus(msg),
    });
    this.tracker.setSwap(this.settings.swap);
  }

  // ==================== 启动 ====================
  async boot() {
    this.bindUI();
    this.resize();
    this.syncSettingsUI();
    this.applyDifficultyUI();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
    this.showOverlay('menu');
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    if (this.settings.keyboardOnly) this.setCamStatus('纯键盘模式：A / L 击打左右列');
    else this.startCamera();
  }

  async startCamera() {
    if (this.tracker.ready) return;
    const ok = await this.tracker.init();
    if (ok) {
      this.tracker.setSwap(this.settings.swap);
      this.toast('手掌识别已就绪 —— 握握拳试试 ✊', 2200);
      if (!store.get('calibrated', false)) {
        setTimeout(() => this.toast('第一次玩？建议先做一次「延迟校准」，判定会准很多', 4000), 2600);
      }
    }
  }

  async ensureAudio() {
    if (!this.audioCtx) {
      this.audioCtx = createAudioContext();
    }
    if (!this.music) {
      this.music = new MusicEngine(this.audioCtx);
      this.music.guide = this.settings.guide;
    }
    if (this.audioCtx.state !== 'running') {
      await this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  // ==================== 尺寸 / 布局 ====================
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth;
    const H = window.innerHeight;
    this.canvas.width = Math.floor(W * dpr);
    this.canvas.height = Math.floor(H * dpr);
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    this.layout();
  }

  layout() {
    const { W, H } = this;
    this.laneW = clamp(Math.min(W * 0.2, (H - 300) * 0.5), 92, 210);
    this.gap = clamp(W * 0.04, 16, 54);
    const half = this.laneW / 2 + this.gap / 2;
    this.laneX = [W / 2 - half - this.laneW / 2, W / 2 + half - this.laneW / 2];
    this.lineY = H - clamp(H * 0.17, 92, 170);
    this.spawnY = -80;
    this.noteH = clamp(this.laneW * 0.2, 18, 34);
    this.approach = DIFFICULTY[this.settings.difficulty].approach;
    this.pxPerSec = (this.lineY - this.spawnY) / this.approach;
    const pw = clamp(W * 0.16, 128, 200);
    this.preview = { x: 18, w: pw, h: pw * 0.75, y: H - pw * 0.75 - 18 };
    this._cacheGfx();
  }

  _cacheGfx() {
    const { ctx, W, H } = this;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#060917');
    g.addColorStop(0.5, '#0a0f22');
    g.addColorStop(1, '#101432');
    this.bgGrad = g;
    const rg = ctx.createRadialGradient(W / 2, H * 0.95, 0, W / 2, H * 0.95, Math.max(W, H) * 0.8);
    rg.addColorStop(0, 'rgba(78,130,255,.18)');
    rg.addColorStop(0.5, 'rgba(120,60,200,.07)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    this.bgRadial = rg;

    const h = this.lineY + this.noteH * 2.4;
    this.laneGrad = [];
    this.laneFlashGrad = [];
    this.lineGrad = [];
    for (let i = 0; i < 2; i++) {
      const lg = ctx.createLinearGradient(0, 0, 0, this.lineY);
      lg.addColorStop(0, `rgba(${LANES[i].rgb},0.015)`);
      lg.addColorStop(0.72, `rgba(${LANES[i].rgb},0.075)`);
      lg.addColorStop(1, `rgba(${LANES[i].rgb},0.17)`);
      this.laneGrad.push(lg);
      const fg = ctx.createLinearGradient(0, Math.max(0, this.lineY - 170), 0, this.lineY);
      fg.addColorStop(0, `rgba(${LANES[i].rgb},0)`);
      fg.addColorStop(1, `rgba(${LANES[i].rgb},0.5)`);
      this.laneFlashGrad.push(fg);
      const x = this.laneX[i];
      const lw = this.laneW;
      const g2 = ctx.createLinearGradient(x, 0, x + lw, 0);
      g2.addColorStop(0, `rgba(${LANES[i].rgb},.25)`);
      g2.addColorStop(0.5, 'rgba(255,255,255,.96)');
      g2.addColorStop(1, `rgba(${LANES[i].rgb},.25)`);
      this.lineGrad.push(g2);
    }
    this._laneH = h;
  }

  // ==================== 主循环 ====================
  frame = (now) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = clamp((now - this.lastFrame) / 1000, 0, 0.05);
    this.lastFrame = now;
    this.update(dt);
    this.render();
  };

  update(dt) {
    if (this.music) this.music.tick();

    if (this.state === 'playing' || this.state === 'calib') {
      this.tickClock();
      this.consumeInput();
      this.spawnNotes();
      this.checkMiss();
      this.updateHUD();
      if (this.state === 'playing' && this.S > this.chart.duration + 0.6 && !this.active.length) this.finish();
      if (this.state === 'calib' && this.calib && this.calib.done) this.finishCalibration();
    } else if (this.state === 'menu') {
      this.menuTime += dt;
      this.S = this.menuTime % this.demo.duration;
      this._clkLast = null;
    }

    // 特效
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 900 * dt;
      p.vx *= 1 - 1.6 * dt;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].life -= dt;
      if (this.rings[i].life <= 0) this.rings.splice(i, 1);
    }
    for (let i = this.judges.length - 1; i >= 0; i--) {
      this.judges[i].life -= dt;
      if (this.judges[i].life <= 0) this.judges.splice(i, 1);
    }
    this.flash = Math.max(0, this.flash - dt * 3.2);
    this.laneFlash[0] = Math.max(0, this.laneFlash[0] - dt * 3.6);
    this.laneFlash[1] = Math.max(0, this.laneFlash[1] - dt * 3.6);
    if (this.state === 'menu') this.syncMenuHands();
  }

  // ==================== 输入 ====================
  consumeInput() {
    const events = this.tracker.drain();
    if (events) {
      for (const ev of events) {
        const arrival = this.songTimeAt(ev.t);
        this.laneInput(ev.lane, arrival - this.settings.latency, arrival, 'hand');
      }
    }
    if (this.keyQueue.length) {
      const q = this.keyQueue;
      this.keyQueue = [];
      for (const k of q) {
        const arrival = this.songTimeAt(k.t);
        const intent = arrival - KEY_LATENCY;
        if (k.lane < 0) {
          this.laneInput(0, intent, arrival, 'key');
          this.laneInput(1, intent, arrival, 'key');
        } else {
          this.laneInput(k.lane, intent, arrival, 'key');
        }
      }
    }
  }

  /**
   * 平滑时钟：AudioContext.currentTime 是按 128/256 采样量化的（步进 3~6ms，
   * 音频线程卡顿时甚至会有几十毫秒的空档），直接拿它当画面时钟会抖。
   * 这里以 performance.now() 为基准推进，再缓慢向音频时钟对齐：
   * 既保证与音乐长期同步，又拿到亚毫秒分辨率。
   */
  tickClock() {
    const now = performance.now() / 1000;
    const target = this.music ? this.music.songTime() : this.S + 0.016;
    if (this._clkLast == null) {
      this.S = target;
      this._clkLast = now;
      return;
    }
    let dt = now - this._clkLast;
    this._clkLast = now;
    if (!(dt > 0) || dt > 0.4) dt = 0;
    this.S += dt;
    const err = target - this.S;
    if (Math.abs(err) > 0.3) this.S = target;
    else this.S += err * 0.05;
  }

  songTimeAt(perfNow) {
    return this.S - (performance.now() - perfNow) / 1000;
  }

  /** intent：玩家"真正想打"的时刻；arrival：信号到达游戏时的时刻 */
  laneInput(lane, intent, arrival, source) {
    let best = null;
    let bestD = 1e9;
    for (const n of this.active) {
      if (n.lane !== lane || n.judged) continue;
      const d = intent - n.time;
      if (Math.abs(d) < Math.abs(bestD)) {
        bestD = d;
        best = n;
      }
    }
    if (!best || Math.abs(bestD) > WINDOW.ok) {
      // 空击：只有视觉反馈，不扣分
      const c = this.laneCenter(lane);
      this.rings.push({ x: c, y: this.lineY, r: this.noteH * 0.6, max: this.laneW * 0.55, life: 0.3, t: 0.3, color: `rgba(${LANES[lane].rgb},.45)`, w: 2 });
      return null;
    }
    const w = Math.abs(bestD);
    const rank = w <= WINDOW.perfect ? 'perfect' : w <= WINDOW.good ? 'good' : 'ok';
    this.hitNote(best, rank, bestD, arrival - best.time);
    return rank;
  }

  hitNote(note, rank, delta, rawDelta) {
    note.judged = true;
    note.state = 'hit';
    note.rank = rank;
    this.score += Math.round(SCORE[rank] * (1 + Math.min(this.combo, 60) / 120));
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.stats[rank]++;
    this.judgeCount++;
    this.accSum += ACC[rank];
    if (this.state === 'calib') this.recordCalibration(note.time, rawDelta);

    const x = this.laneCenter(note.lane);
    const y = this.lineY;
    const col = LANES[note.lane];
    if (this.music) this.music.hitNote(midiToFreq(note.pitch));
    this.burst(x, y, col.rgb, rank === 'perfect' ? 22 : 13, rank === 'ok' ? 0.6 : 1);
    this.rings.push({ x, y, r: this.noteH * 0.6, max: this.laneW * (rank === 'perfect' ? 1.35 : 0.95), life: 0.45, t: 0.45, color: `rgba(${col.rgb},.92)`, w: 3 });
    this.judges.push({ lane: note.lane, text: rank.toUpperCase(), color: JCOLOR[rank], life: 0.7, t: 0.7, delta });
    this.flash = Math.max(this.flash, rank === 'perfect' ? 1 : 0.55);
    this.laneFlash[note.lane] = 1;
    if (this.combo > 0 && this.combo % 25 === 0) this.toast(`${this.combo} COMBO! 🔥`, 900);
  }

  missNote(note) {
    note.judged = true;
    note.state = 'miss';
    note.missT = this.S;
    if (this.state === 'calib') return; // 校准不判定 miss
    this.combo = 0;
    this.stats.miss++;
    this.judgeCount++;
    if (this.music) this.music.missNote();
    this.judges.push({ lane: note.lane, text: 'MISS', color: JCOLOR.miss, life: 0.6, t: 0.6, delta: 0 });
  }

  burst(x, y, rgb, count, power = 1) {
    if (this.particles.length > 420) return;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (60 + Math.random() * 430) * power;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp * 0.7 - 70,
        life: 0.4 + Math.random() * 0.5,
        t: 0.9,
        size: 1.6 + Math.random() * 3.4,
        color: Math.random() < 0.5 ? 'rgba(255,255,255,.95)' : `rgba(${rgb},.95)`,
      });
    }
  }

  laneCenter(lane) {
    return this.laneX[lane] + this.laneW / 2;
  }

  // ==================== 谱面推进 ====================
  spawnNotes() {
    const chart = this.chart;
    while (this.notePtr < chart.notes.length && chart.notes[this.notePtr].time - this.approach <= this.S + 0.001) {
      this.active.push({ ...chart.notes[this.notePtr++], judged: false, state: 'pending' });
    }
  }

  checkMiss() {
    const deadline = this.settings.latency + WINDOW.miss;
    for (const n of this.active) {
      if (!n.judged && this.S > n.time + deadline) this.missNote(n);
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const n = this.active[i];
      if (n.state === 'hit') this.active.splice(i, 1);
      else if (n.state === 'miss' && this.S - n.missT > 0.75) this.active.splice(i, 1);
    }
  }

  // ==================== 开始 / 结束 ====================
  async startGame({ calib = false } = {}) {
    await this.ensureAudio();
    this.music.guide = this.settings.guide;
    const seed = calib ? 7 : (Math.random() * 1e9) | 0;
    this.chart = calib ? buildCalibrationChart({ bpm: 100, seed }) : buildChart({ difficulty: this.settings.difficulty, seed });
    this.approach = this.chart.approach;
    this.pxPerSec = (this.lineY - this.spawnY) / this.approach;
    this.active = [];
    this.notePtr = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.stats = { perfect: 0, good: 0, ok: 0, miss: 0 };
    this.judgeCount = 0;
    this.accSum = 0;
    this.particles = [];
    this.rings = [];
    this.judges = [];
    this.flash = 0;
    this.laneFlash = [0, 0];
    this.S = 0;
    this._clkLast = null;
    this.tracker.events = [];
    this.keyQueue = [];
    this.music.begin(this.chart.events, { latency: 0, delayTime: this.chart.beatDur * 0.7 });
    this.state = calib ? 'calib' : 'playing';
    if (calib) {
      this.calib = { samples: [], seen: new Set(), done: false };
      this.buildCalibDots();
    }
    this.showOverlay(null);
    $('#calibHud').classList.toggle('hidden', !calib);
    $('#hud').classList.toggle('hidden', calib);
    this.hudCache = {};
    if (!calib) this.updateHUD(true);
  }

  finish() {
    this.state = 'results';
    if (this.music) this.music.stop();
    const acc = this.judgeCount ? this.accSum / this.judgeCount : 0;
    $('#finalScore').textContent = this.score.toLocaleString();
    $('#finalAcc').textContent = (acc * 100).toFixed(1) + '%';
    $('#finalCombo').textContent = this.maxCombo;
    $('#finalPerfect').textContent = this.stats.perfect;
    $('#finalGood').textContent = this.stats.good;
    $('#finalOk').textContent = this.stats.ok;
    $('#finalMiss').textContent = this.stats.miss;
    let rank = 'D';
    if (acc >= 0.985) rank = 'S+';
    else if (acc >= 0.93) rank = 'S';
    else if (acc >= 0.85) rank = 'A';
    else if (acc >= 0.75) rank = 'B';
    else if (acc >= 0.6) rank = 'C';
    $('#rankBadge').textContent = rank;
    const clean = this.judgeCount > 0 && this.stats.miss === 0 && this.stats.ok === 0 && this.stats.good === 0;
    const fc = this.judgeCount > 0 && this.stats.miss === 0;
    $('#finalNote').textContent = clean
      ? '全 PERFECT！你的双手就是节拍器 ✊'
      : fc
        ? 'FULL COMBO！一个都没漏 ✨'
        : rank === 'D'
          ? '别急，先做一次「延迟校准」会顺手很多'
          : '再来一次，节奏会更顺的';
    this.showOverlay('results');
    $('#hud').classList.add('hidden');
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.tracker.drain();
    if (this.audioCtx) this.audioCtx.suspend();
    this.showOverlay('pause');
  }

  async resume() {
    if (this.state !== 'paused') return;
    if (this.audioCtx && this.audioCtx.state !== 'running') await this.audioCtx.resume().catch(() => {});
    this.tracker.drain();
    this.lastFrame = performance.now();
    this._clkLast = null;
    this.state = 'playing';
    this.showOverlay(null);
  }

  quit() {
    this.state = 'menu';
    if (this.music) this.music.stop();
    if (this.audioCtx && this.audioCtx.state === 'running') this.audioCtx.suspend();
    this.active = [];
    this.particles = [];
    this.rings = [];
    this.judges = [];
    this.showOverlay('menu');
    $('#calibHud').classList.add('hidden');
    $('#hud').classList.add('hidden');
    this.menuTime = 0;
  }

  // ==================== 延迟校准 ====================
  buildCalibDots() {
    const wrap = $('#calibDots');
    wrap.innerHTML = '';
    for (let i = 0; i < 8; i++) wrap.appendChild(document.createElement('i'));
  }

  /**
   * rawDelta = 信号到达时刻 - 音符理论时刻（未经补偿）
   * 玩家在音符到线时握拳，所以 rawDelta ≈ 系统总延迟，把它设成补偿量即可。
   */
  recordCalibration(key, rawDelta) {
    const c = this.calib;
    if (c.seen.has(key)) return;
    c.seen.add(key);
    c.samples.push(rawDelta);
    const dots = $('#calibDots').children;
    const i = c.samples.length - 1;
    if (dots[i]) dots[i].classList.add('on');
    if (c.samples.length >= 8) c.done = true;
  }

  finishCalibration() {
    const samples = this.calib.samples.filter((d) => Math.abs(d) < 0.6);
    if (samples.length >= 3) {
      const m = median(samples);
      const v = clamp(m, 0.02, 0.5);
      this.settings.latency = Math.round(v * 1000) / 1000;
      store.set('latency', this.settings.latency);
      store.set('calibrated', true);
      this.syncSettingsUI();
      this.toast(`校准完成：延迟补偿 ${Math.round(v * 1000)} ms ✓`, 2800);
    } else {
      this.toast('有效样本太少，保持原设置（靠近镜头、光线亮一点会更准）', 3000);
    }
    this.state = 'menu';
    if (this.music) this.music.stop();
    if (this.audioCtx && this.audioCtx.state === 'running') this.audioCtx.suspend();
    this.active = [];
    this.tracker.events = [];
    this.showOverlay('menu');
    $('#calibHud').classList.add('hidden');
    $('#hud').classList.add('hidden');
    this.menuTime = 0;
  }

  // ==================== 渲染 ====================
  render() {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = this.bgGrad;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = this.bgRadial;
    ctx.fillRect(0, 0, W, H);

    const inSong = this.state === 'playing' || this.state === 'calib' || this.state === 'paused' || this.state === 'results';
    const list = inSong ? this.active : this.demoNotes();
    this.drawBeatGrid();
    this.drawLanes();
    this.drawHitLine();
    this.drawNotes(list);
    this.drawEffects();
    this.drawJudges();
    if (this.state === 'playing' || this.state === 'calib') this.drawCountIn();
    if (this.settings.preview && this.tracker.ready) this.drawPreview();
    this.drawVignette();
  }

  demoNotes() {
    const out = [];
    const t0 = this.S;
    const list = this.demo.notes;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.time - this.approach > t0) break;
      if (n.time + 0.55 > t0) out.push(n);
    }
    return out;
  }

  noteY(n, S) {
    const px = this.pxPerSec;
    if (!n.judged) {
      const d = n.time - S;
      return d > 0 ? this.lineY - d * px : this.lineY;
    }
    if (n.state === 'hit') return this.lineY;
    const m = n.missT == null ? S : n.missT;
    return this.lineY + Math.max(0, S - m) * px * 1.25;
  }

  drawBeatGrid() {
    const { ctx } = this;
    const c = this.state === 'menu' ? this.demo : this.chart;
    if (!c) return;
    const S = this.S;
    const px = this.pxPerSec;
    const left = this.laneX[0] - 14;
    const right = this.laneX[1] + this.laneW + 14;
    for (let i = 0; i < c.beats.length; i++) {
      const d = c.beats[i] - S;
      if (d < -0.25) continue;
      if (d > this.approach + 0.05) break;
      const y = this.lineY - d * px;
      if (y < -20 || y > this.lineY + 4) continue;
      const isBar = i % 4 === 0;
      ctx.strokeStyle = `rgba(150,200,255,${(0.055 + (1 - d / this.approach) * 0.1 + (isBar ? 0.08 : 0)).toFixed(3)})`;
      ctx.lineWidth = isBar ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(left, Math.round(y) + 0.5);
      ctx.lineTo(right, Math.round(y) + 0.5);
      ctx.stroke();
    }
  }

  drawLanes() {
    const { ctx } = this;
    for (let i = 0; i < 2; i++) {
      const x = this.laneX[i];
      ctx.fillStyle = this.laneGrad[i];
      roundRect(ctx, x, 0, this.laneW, this._laneH, 16);
      ctx.fill();
      const flash = this.laneFlash[i];
      if (flash > 0.01) {
        ctx.globalAlpha = clamp(flash, 0, 1) * 0.55;
        ctx.fillStyle = this.laneFlashGrad[i];
        roundRect(ctx, x, 0, this.laneW, this._laneH, 16);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = `rgba(${LANES[i].rgb},0.16)`;
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, 0.5, this.laneW - 1, this._laneH - 1, 16);
      ctx.stroke();
    }
  }

  pulse() {
    const c = this.state === 'menu' ? this.demo : this.chart || this.demo;
    const bd = c.beatDur;
    const p = ((this.S % bd) + bd) % bd;
    return Math.exp(-p * 9);
  }

  drawHitLine() {
    const { ctx } = this;
    const beat = this.pulse();
    for (let i = 0; i < 2; i++) {
      const x = this.laneX[i];
      ctx.save();
      ctx.shadowColor = `rgba(${LANES[i].rgb},${(0.7 + beat * 0.3).toFixed(2)})`;
      ctx.shadowBlur = 20 + beat * 16;
      ctx.globalAlpha = clamp(0.72 + beat * 0.28 + this.laneFlash[i] * 0.4, 0, 1);
      ctx.fillStyle = this.lineGrad[i];
      roundRect(ctx, x, this.lineY - 3, this.laneW, 6, 3);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = `rgba(255,255,255,${(0.5 + beat * 0.45).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(x + this.laneW / 2, this.lineY, 3 + beat * 2.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = '600 11px "PingFang SC",system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(${LANES[i].rgb},.42)`;
      ctx.fillText(LANES[i].name, x + this.laneW / 2, this.lineY + 48);
    }
  }

  drawNotes(list) {
    const { ctx } = this;
    const S = this.S;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.state === 'hit') continue;
      const y = this.noteY(n, S);
      if (y < -50 || y > this.lineY + 300) continue;
      const x = this.laneX[n.lane];
      const w = this.laneW;
      const h = this.noteH;
      const col = LANES[n.lane];
      const isDemo = n.state == null;
      const hold = !n.judged && n.time <= S;
      const dist = Math.abs(n.time - S);
      const near = clamp(1 - dist / (this.approach * 0.35), 0, 1);
      let alpha = 1;
      if (n.state === 'miss') alpha = clamp(1 - (S - (n.missT || S)) / 0.6, 0, 1);
      else if (isDemo && S > n.time) alpha = clamp(1 - (S - n.time) / 0.5, 0, 1);

      const tg = ctx.createLinearGradient(0, y - h * 3.4, 0, y);
      tg.addColorStop(0, `rgba(${col.rgb},0)`);
      tg.addColorStop(1, `rgba(${col.rgb},${(0.15 * alpha).toFixed(3)})`);
      ctx.fillStyle = tg;
      roundRect(ctx, x + w * 0.27, y - h * 3.4, w * 0.46, h * 3.4, 10);
      ctx.fill();

      ctx.globalAlpha = alpha;
      ctx.save();
      ctx.shadowColor = `rgba(${col.rgb},${(0.5 + near * 0.5).toFixed(2)})`;
      ctx.shadowBlur = 13 + near * 20 + (hold ? 16 : 0);
      const fg = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2);
      fg.addColorStop(0, '#ffffff');
      fg.addColorStop(0.42, col.color);
      fg.addColorStop(1, `rgba(${col.rgb},.55)`);
      ctx.fillStyle = fg;
      roundRect(ctx, x + w * 0.09, y - h / 2, w * 0.82, h, h / 2);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = 'rgba(255,255,255,.92)';
      roundRect(ctx, x + w * 0.09, y + h / 2 - 4, w * 0.82, 2.6, 1.3);
      ctx.fill();

      if (hold) {
        const k = (S * 3) % 1;
        ctx.strokeStyle = `rgba(255,255,255,${(0.5 * (1 - k)).toFixed(3)})`;
        ctx.lineWidth = 2;
        roundRect(ctx, x + w * 0.09 - k * 8, y - h / 2 - k * 8, w * 0.82 + k * 16, h + k * 16, (h + k * 16) / 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  drawEffects() {
    const { ctx } = this;
    for (const r of this.rings) {
      const k = 1 - r.life / r.t;
      const rad = lerp(r.r, r.max, easeOutCubic(k));
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.w * (1 - k * 0.7);
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, rad, rad * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of this.particles) {
      const a = clamp(p.life / p.t, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawJudges() {
    const { ctx } = this;
    ctx.textAlign = 'center';
    for (const j of this.judges) {
      const k = 1 - j.life / j.t;
      const x = this.laneCenter(j.lane);
      const y = this.lineY - 34 - easeOutCubic(k) * 38;
      const a = k < 0.18 ? k / 0.18 : 1 - (k - 0.18) / 0.82;
      const pop = 1 + (k < 0.18 ? (1 - k / 0.18) * 0.35 : 0);
      ctx.globalAlpha = clamp(a * 1.15, 0, 1);
      ctx.font = `800 ${Math.round(22 * pop)}px "PingFang SC",system-ui,sans-serif`;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(4,8,20,.72)';
      ctx.strokeText(j.text, x, y);
      ctx.fillStyle = j.color;
      ctx.shadowColor = j.color;
      ctx.shadowBlur = 18;
      ctx.fillText(j.text, x, y);
      ctx.shadowBlur = 0;
      if (j.delta && Math.abs(j.delta) > 0.001) {
        ctx.font = '700 10.5px system-ui,sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(4,8,20,.7)';
        ctx.strokeText(`${j.delta > 0 ? '+' : ''}${Math.round(j.delta * 1000)}ms`, x, y + 14);
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        ctx.fillText(`${j.delta > 0 ? '+' : ''}${Math.round(j.delta * 1000)}ms`, x, y + 14);
      }
    }
    ctx.globalAlpha = 1;
  }

  drawCountIn() {
    const { ctx, W, H } = this;
    const bd = this.chart.beatDur;
    const first = this.chart.notes.length ? this.chart.notes[0].time : 0;
    const left = first - this.S;
    if (left > bd * 6 || left < -0.35) return;
    const frac = (this.S % bd) / bd;
    const label = left <= 0 ? 'GO!' : left <= bd * 4 ? String(Math.max(1, Math.ceil(left / bd))) : '准备';
    const size = left <= bd * 4 ? 62 - frac * 14 : 26;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.globalAlpha = clamp(1 - frac * 0.85, 0, 1) * 0.95;
    ctx.font = `800 ${size}px "PingFang SC",system-ui,sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(120,200,255,.9)';
    ctx.shadowBlur = 26;
    ctx.fillText(label, W / 2, H * 0.3);
    ctx.restore();
  }

  drawPreview() {
    const { ctx, tracker } = this;
    const { w: pw, h: ph, x: px, y: py } = this.preview;
    const v = this.video;
    ctx.save();
    roundRect(ctx, px - 4, py - 4, pw + 8, ph + 8, 14);
    ctx.fillStyle = 'rgba(8,12,26,.86)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,190,255,.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    roundRect(ctx, px, py, pw, ph, 10);
    ctx.clip();
    if (v.readyState >= 2 && v.videoWidth) {
      const scale = Math.max(pw / v.videoWidth, ph / v.videoHeight);
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      const ox = (pw - dw) / 2;
      const oy = (ph - dh) / 2;
      ctx.translate(px + pw, py);
      ctx.scale(-1, 1);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(v, ox, oy, dw, dh);
      ctx.globalAlpha = 1;
      for (const h of tracker.handList) {
        const dx = ox + h.x * dw;
        const dy = oy + h.y * dh;
        const hot = clamp((h.score - this.tracker.threshold * 0.3) / (this.tracker.threshold * 0.7), 0, 1);
        const rgb = h.lane >= 0 ? LANES[h.lane].rgb : '190,150,255';
        ctx.beginPath();
        ctx.arc(dx, dy, 11 + hot * 6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb},${(0.25 + hot * 0.75).toFixed(2)})`;
        ctx.lineWidth = 1.6 + hot * 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(dx, dy, 17, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(h.score, 0, 1));
        ctx.strokeStyle = h.closed ? `rgba(${rgb},.95)` : 'rgba(255,255,255,.22)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.save();
    ctx.font = '600 10px system-ui,sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = tracker.handFound ? 'rgba(140,255,190,.85)' : 'rgba(255,160,160,.85)';
    ctx.fillText(
      (tracker.handFound ? '已找到手' : '没看到手') + ` · ${Math.round(tracker.fps)}fps · ${Math.round(tracker.detectMs)}ms`,
      px - 2,
      py - 10,
    );
    ctx.restore();
  }

  drawVignette() {
    if (this.flash < 0.02) return;
    const { ctx, W, H } = this;
    const g = ctx.createRadialGradient(W / 2, this.lineY, 0, W / 2, this.lineY, Math.max(W, H) * 0.7);
    g.addColorStop(0, `rgba(160,220,255,${(0.1 * this.flash).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ==================== HUD / UI ====================
  updateHUD(force = false) {
    if (force) this.hudCache = {};
    const acc = this.judgeCount ? this.accSum / this.judgeCount : 1;
    if (this.hudCache.score !== this.score) {
      this.hudCache.score = this.score;
      $('#scoreVal').textContent = this.score.toLocaleString();
    }
    if (this.hudCache.combo !== this.combo) {
      this.hudCache.combo = this.combo;
      const el = $('#comboVal');
      el.textContent = this.combo;
      el.style.transition = 'transform .14s ease';
      el.style.transform = 'scale(1.18)';
      setTimeout(() => (el.style.transform = 'scale(1)'), 90);
    }
    const accTxt = (acc * 100).toFixed(1) + '%';
    if (this.hudCache.acc !== accTxt) {
      this.hudCache.acc = accTxt;
      $('#accVal').textContent = accTxt;
    }
    const p = clamp(this.S / (this.chart ? this.chart.duration : 1), 0, 1);
    $('#progressBar').style.width = (p * 100).toFixed(2) + '%';
    if (this.state === 'calib') {
      const n = this.calib ? this.calib.samples.length : 0;
      const el = $('#calibText');
      const txt = n >= 8 ? '完成！' : `跟着节拍握拳 · ${n}/8`;
      if (el.textContent !== txt) el.textContent = txt;
    }
  }

  syncMenuHands() {
    const l = $('#demoHandL');
    const r = $('#demoHandR');
    if (!l) return;
    const on = this.tracker.ready && this.tracker.handFound;
    l.classList.toggle('fist', !!(on && this.tracker.hands[0].closed));
    r.classList.toggle('fist', !!(on && this.tracker.hands[1].closed));
  }

  showOverlay(name) {
    const overlay = $('#overlay');
    if (!name) {
      overlay.classList.add('hidden');
      return;
    }
    overlay.classList.remove('hidden');
    overlay.querySelectorAll('.panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
  }

  toast(msg, ms = 1800) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('on'), ms);
  }

  setCamStatus(msg) {
    const el = $('#camStatus');
    if (el) el.textContent = msg;
  }

  syncSettingsUI() {
    $('#inLatency').value = Math.round(this.settings.latency * 1000);
    $('#outLatency').textContent = Math.round(this.settings.latency * 1000) + ' ms';
    $('#inThreshold').value = this.tracker.threshold;
    $('#outThreshold').textContent = this.tracker.threshold.toFixed(2);
    $('#inPreview').checked = !!this.settings.preview;
    $('#inGuide').checked = !!this.settings.guide;
    $('#inSwap').checked = !!this.settings.swap;
    $('#inKeyboard').checked = !!this.settings.keyboardOnly;
  }

  applyDifficultyUI() {
    document.querySelectorAll('#diffBar button').forEach((b) => b.classList.toggle('on', b.dataset.diff === this.settings.difficulty));
  }

  bindUI() {
    $('#btnStart').addEventListener('click', async () => {
      await this.ensureAudio();
      this.music.uiClick(true);
      this.startGame();
    });
    $('#btnCalib').addEventListener('click', async () => {
      await this.ensureAudio();
      await this.startGame({ calib: true });
      this.music.uiClick(true);
    });
    $('#btnSettings').addEventListener('click', () => this.showOverlay('settings'));
    $('#btnHelp').addEventListener('click', () => this.showOverlay('help'));
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.showOverlay('menu')));
    $('#btnCalibCancel').addEventListener('click', () => this.quit());

    document.querySelectorAll('#diffBar button').forEach((b) =>
      b.addEventListener('click', () => {
        this.settings.difficulty = b.dataset.diff;
        store.set('difficulty', this.settings.difficulty);
        this.applyDifficultyUI();
        this.approach = DIFFICULTY[this.settings.difficulty].approach;
        this.pxPerSec = (this.lineY - this.spawnY) / this.approach;
      }),
    );

    $('#inLatency').addEventListener('input', (e) => {
      this.settings.latency = clamp(Number(e.target.value) / 1000, 0, 0.6);
      $('#outLatency').textContent = e.target.value + ' ms';
      store.set('latency', this.settings.latency);
    });
    $('#inThreshold').addEventListener('input', (e) => {
      this.tracker.setThreshold(Number(e.target.value));
      $('#outThreshold').textContent = Number(e.target.value).toFixed(2);
    });
    $('#inPreview').addEventListener('change', (e) => {
      this.settings.preview = e.target.checked;
      store.set('preview', this.settings.preview);
    });
    $('#inGuide').addEventListener('change', (e) => {
      this.settings.guide = e.target.checked;
      store.set('guide', this.settings.guide);
      if (this.music) this.music.guide = this.settings.guide;
    });
    $('#inSwap').addEventListener('change', (e) => {
      this.settings.swap = e.target.checked;
      store.set('swap', this.settings.swap);
      this.tracker.setSwap(this.settings.swap);
    });
    $('#inKeyboard').addEventListener('change', (e) => {
      this.settings.keyboardOnly = e.target.checked;
      store.set('keyboardOnly', this.settings.keyboardOnly);
      if (this.settings.keyboardOnly) {
        this.tracker.stop();
        this.setCamStatus('纯键盘模式：A / L 击打左右列');
      } else {
        this.tracker.ready = false;
        this.startCamera();
      }
    });

    $('#btnResume').addEventListener('click', () => this.resume());
    $('#btnRestart').addEventListener('click', () => this.startGame());
    $('#btnQuit').addEventListener('click', () => this.quit());
    $('#btnAgain').addEventListener('click', () => this.startGame());
    $('#btnBack').addEventListener('click', () => this.quit());
    $('#camStatus').addEventListener('click', () => this.startCamera());

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        if (this.state === 'playing') this.pause();
        else if (this.state === 'paused') this.resume();
        return;
      }
      if (this.state !== 'playing' && this.state !== 'calib') return;
      if (k === 'a') this.keyQueue.push({ lane: 0, t: performance.now() });
      else if (k === 'l') this.keyQueue.push({ lane: 1, t: performance.now() });
      else if (k === ' ') this.keyQueue.push({ lane: -1, t: performance.now() });
      else return;
      e.preventDefault();
    });

    window.addEventListener('blur', () => {
      if (this.state === 'playing') this.pause();
    });
  }
}

const game = new Game();
window.__palmBeat = game;
window.__blinkBeat = game;
game.boot();
