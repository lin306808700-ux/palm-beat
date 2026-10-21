// ========== 音乐引擎（Web Audio 实时合成，无需任何音频文件） ==========
import { midiToFreq, clamp } from './util.js';

const LOOKAHEAD = 0.26; // 预排时间（秒）

export class MusicEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.playing = false;
    this.ptr = 0;
    this.events = [];
    this.origin = 0;
    this.latency = 0.13;
    this.guide = true;
    this.musicGain = 0.85;

    // ---- 主输出链 ----
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -11;
    lim.knee.value = 14;
    lim.ratio.value = 6;
    lim.attack.value = 0.003;
    lim.release.value = 0.25;
    this.master.connect(lim);
    lim.connect(ctx.destination);

    // ---- 分轨 ----
    this.drumBus = ctx.createGain();
    this.drumBus.gain.value = 0.95;
    this.drumBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.7;
    this.musicBus.connect(this.master);

    this.hitBus = ctx.createGain();
    this.hitBus.gain.value = 1.0;
    this.hitBus.connect(this.master);

    // ---- 混响 ----
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(1.9, 2.4);
    this.revGain = ctx.createGain();
    this.revGain.gain.value = 0.4;
    this.reverb.connect(this.revGain);
    this.revGain.connect(this.master);
    this.musicBus.connect(this.reverb);
    this.hitBus.connect(this.reverb);

    // ---- 延迟 ----
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.3;
    this.delayFb = ctx.createGain();
    this.delayFb.gain.value = 0.32;
    this.delayWet = ctx.createGain();
    this.delayWet.gain.value = 0.22;
    this.delay.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delay.connect(this.delayWet);
    this.delayWet.connect(this.master);
    this.hitBus.connect(this.delay);
    this.musicBus.connect(this.delay);

    this.noise = this._noise(2.0);
    this._tickTimer = 0;
    this._lastTick = 0;
  }

  // ================= 基础素材 =================
  _noise(sec) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _impulse(sec, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.5);
      }
    }
    return buf;
  }

  _noiseSrc(when) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(when, Math.random() * 1.5);
    return s;
  }

  _env(param, when, peak, attack, decay, floor = 0.0001) {
    param.setValueAtTime(floor, when);
    param.exponentialRampToValueAtTime(Math.max(peak, floor * 2), when + attack);
    param.exponentialRampToValueAtTime(floor, when + attack + decay);
  }

  // ================= 鼓组 =================
  kick(when, gain = 1) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.13);
    const g = ctx.createGain();
    this._env(g.gain, t, 0.95 * gain, 0.006, 0.3);
    o.connect(g);
    g.connect(this.drumBus);
    o.start(t);
    o.stop(t + 0.4);

    const n = this._noiseSrc(t);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1100;
    const ng = ctx.createGain();
    this._env(ng.gain, t, 0.22 * gain, 0.002, 0.02);
    n.connect(hp);
    hp.connect(ng);
    ng.connect(this.drumBus);
    n.stop(t + 0.06);
  }

  snare(when, gain = 1) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const n = this._noiseSrc(t);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.9;
    const ng = ctx.createGain();
    this._env(ng.gain, t, 0.45 * gain, 0.003, 0.17);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(this.drumBus);
    ng.connect(this.reverb);
    n.stop(t + 0.25);

    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.1);
    const g = ctx.createGain();
    this._env(g.gain, t, 0.28 * gain, 0.004, 0.12);
    o.connect(g);
    g.connect(this.drumBus);
    o.start(t);
    o.stop(t + 0.2);
  }

  hat(when, gain = 1, open = false) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const n = this._noiseSrc(t);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7800;
    const g = ctx.createGain();
    const dur = open ? 0.19 : 0.045;
    this._env(g.gain, t, 0.3 * gain, 0.002, dur);
    n.connect(hp);
    hp.connect(g);
    g.connect(this.drumBus);
    n.stop(t + dur + 0.05);
  }

  click(when, accent = false) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = accent ? 1600 : 1050;
    const g = ctx.createGain();
    this._env(g.gain, t, accent ? 0.16 : 0.1, 0.002, 0.05);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    o.connect(lp);
    lp.connect(g);
    g.connect(this.drumBus);
    o.start(t);
    o.stop(t + 0.1);
  }

  // ================= 和声 / 低音 =================
  bass(pitch, when, dur = 0.22, gain = 0.5) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const f = midiToFreq(pitch);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = f / 2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 7;
    lp.frequency.setValueAtTime(Math.min(2200, f * 9), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(110, f * 2.2), t + dur * 0.9);
    const g = ctx.createGain();
    this._env(g.gain, t, 0.42 * gain, 0.008, dur);
    o.connect(lp);
    sub.connect(lp);
    lp.connect(g);
    g.connect(this.musicBus);
    o.start(t);
    sub.start(t);
    o.stop(t + dur + 0.12);
    sub.stop(t + dur + 0.12);
  }

  pad(pitches, when, dur, gain = 0.05) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1150;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.35, dur * 0.25));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    lp.connect(g);
    g.connect(this.musicBus);
    for (const p of pitches) {
      for (let d = 0; d < 2; d++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToFreq(p);
        o.detune.value = d === 0 ? -6 : 7;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.2);
      }
    }
  }

  // ================= 旋律 / 打击反馈 =================
  /** 旋律提示音（很轻，只为守住节奏骨架） */
  guideNote(pitch, when, gain = 0.05) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const f = midiToFreq(pitch);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = f * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.28;
    const g = ctx.createGain();
    this._env(g.gain, t, gain, 0.01, 0.5);
    o.connect(g);
    o2.connect(g2);
    g2.connect(g);
    g.connect(this.musicBus);
    o.start(t);
    o2.start(t);
    o.stop(t + 0.6);
    o2.stop(t + 0.6);
  }

  /** 玩家击中：明亮的钟琴音 */
  hitNote(pitch, when = null) {
    const ctx = this.ctx;
    const t = Math.max(when == null ? ctx.currentTime : when, ctx.currentTime);
    const f = midiToFreq(pitch);
    const out = ctx.createGain();
    this._env(out.gain, t, 0.3, 0.004, 0.75);
    out.connect(this.hitBus);

    const specs = [
      ['sine', f, 1],
      ['triangle', f * 2, 0.35],
      ['sine', f * 3.01, 0.14],
    ];
    for (const [type, freq, amp] of specs) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = (Math.random() - 0.5) * 6;
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + 0.85);
    }
    // 起音瞬间的金属颗粒
    const n = this._noiseSrc(t);
    const bp = ctx.createBiquadFilter();
    bp.type = 'highpass';
    bp.frequency.value = 3000;
    const ng = ctx.createGain();
    this._env(ng.gain, t, 0.06, 0.001, 0.03);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(this.hitBus);
    n.stop(t + 0.08);
  }

  /** 漏掉音符：闷响 */
  missNote(when = null) {
    const ctx = this.ctx;
    const t = Math.max(when == null ? ctx.currentTime : when, ctx.currentTime);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(72, t + 0.16);
    const g = ctx.createGain();
    this._env(g.gain, t, 0.2, 0.004, 0.2);
    o.connect(g);
    g.connect(this.musicBus);
    o.start(t);
    o.stop(t + 0.3);
  }

  uiClick(hi = false) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(hi ? 880 : 620, t);
    o.frequency.exponentialRampToValueAtTime(hi ? 1320 : 880, t + 0.06);
    const g = ctx.createGain();
    this._env(g.gain, t, 0.12, 0.003, 0.08);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.15);
  }

  // ================= 调度 =================
  begin(events, { latency = 0.13, delayTime = 0.3 } = {}) {
    this.events = events;
    this.ptr = 0;
    this.latency = latency;
    this.playing = true;
    this.delay.delayTime.value = delayTime;
    // 歌曲时间 0 对应的 audio 时刻；整体再往后推 latency，
    // 这样"画面上的音符到线"与"音轨发声"完全同步（详见 README 的延迟模型）
    this.origin = this.ctx.currentTime + 0.2;
  }

  stop() {
    this.playing = false;
    this.events = [];
    this.ptr = 0;
  }

  /** 当前歌曲时间（= 画面使用的时钟） */
  songTime() {
    return this.ctx.currentTime - this.origin;
  }

  /** 每帧调用：把即将到来的事件排进 Web Audio 时间轴 */
  tick() {
    if (!this.playing) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    while (this.ptr < this.events.length) {
      const ev = this.events[this.ptr];
      const at = this.origin + ev.time + this.latency;
      if (at > horizon) break;
      this.ptr++;
      if (ev.type === 'guide' && !this.guide) continue;
      this._schedule(ev, at);
    }
  }

  /** 重置调度游标（用于跳转/取消已排事件后的恢复） */
  rescheduleFrom(songTime) {
    let i = 0;
    while (i < this.events.length && this.events[i].time < songTime) i++;
    this.ptr = i;
  }

  _schedule(ev, at) {
    switch (ev.type) {
      case 'kick':
        if (ev.gain) this.kick(at, ev.gain);
        break;
      case 'snare':
        this.snare(at, ev.gain || 1);
        break;
      case 'hat':
        this.hat(at, ev.gain || 1, !!ev.open);
        break;
      case 'bass':
        this.bass(ev.pitch, at, ev.dur, ev.gain);
        break;
      case 'pad':
        this.pad(ev.pitches, at, ev.dur, ev.gain);
        break;
      case 'guide':
        this.guideNote(ev.pitch, at, ev.gain);
        break;
      case 'click':
        this.click(at, !!ev.accent);
        break;
      default:
        break;
    }
  }
}

/** 建立 AudioContext（需在用户手势内调用） */
export function createAudioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: 'interactive' });
  return ctx;
}

export const audioUtil = { clamp, LOOKAHEAD };
