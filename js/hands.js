// ========== 摄像头 + 手掌张合识别（MediaPipe HandLandmarker）==========
// 优先加载本地 vendor 里的模型（可离线），失败再退回 CDN。
import { clamp, store } from './util.js';

const LOCAL = {
  bundle: new URL('../vendor/vision_bundle.mjs', import.meta.url).href,
  wasm: new URL('../vendor/wasm', import.meta.url).href,
  model: new URL('../vendor/hand_landmarker.task', import.meta.url).href,
};
const CDN = {
  bundle: 'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
  wasm: 'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm',
  model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

// 四根手指的 [掌指关节, 指尖]（拇指不参与，握拳时它最容易挡住掌心）
const FINGERS = [
  [5, 8], // 食指
  [9, 12], // 中指
  [13, 16], // 无名指
  [17, 20], // 小指
];

const dist3 = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.hypot(dx, dy, dz);
};

/**
 * 用关键点几何算「张开度」：
 * 指尖到手腕的距离 / 对应掌指关节到手腕的距离。
 * 张开时约 1.7~2.4，握拳时约 1.0~1.2，和手的朝向、远近基本无关。
 */
export function palmOpenness(P) {
  let sum = 0;
  let n = 0;
  for (const [mcp, tip] of FINGERS) {
    const base = dist3(P[0], P[mcp]);
    if (!base) continue;
    const ratio = dist3(P[0], P[tip]) / base;
    sum += clamp((ratio - 1.12) / 0.68, 0, 1);
    n++;
  }
  return n ? sum / n : 0;
}

export class HandTracker {
  constructor({ video, onStatus = () => {} } = {}) {
    this.video = video;
    this.onStatus = onStatus;
    this.ready = false;
    this.error = null;
    this.handFound = false;
    this.usingGPU = true;
    this.detectInterval = 33;
    // 0 = 完全张开，1 = 完全握拳
    this.threshold = store.get('fistThreshold', 0.55) || 0.55;
    this.swap = false;
    this.started = false;

    /** 待游戏消费的握拳事件：{lane, t(performance.now), strength} */
    this.events = [];
    /** 按音轨记录的状态，供 HUD / 菜单指示：{score, closed, x, y, seen} */
    this.hands = [
      { score: 0, closed: false, x: 0.35, y: 0.5, seen: false },
      { score: 0, closed: false, x: 0.65, y: 0.5, seen: false },
    ];
    /** 本帧实际看到的手（可能 0/1/2 只），供预览窗口画环 */
    this.handList = [];
    this.fps = 0;
    this.detectMs = 0;
    this.msg = '未启动';

    this._st = [
      { closed: false, since: 0, last: -1e9 },
      { closed: false, since: 0, last: -1e9 },
    ];
    this._lastTimes = [];
    this._lastCount = 0;
    this._raf = 0;
    this._lastDetect = 0;
    this._canvas = document.createElement('canvas');
    this._ctx2d = this._canvas.getContext('2d', { willReadFrequently: false });
  }

  setThreshold(v) {
    this.threshold = clamp(v, 0.25, 0.9);
    store.set('fistThreshold', this.threshold);
  }

  setSwap(v) {
    this.swap = !!v;
  }

  async init() {
    try {
      this.onStatus('请求摄像头权限…');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('浏览器不支持摄像头（需要 https 或 localhost）');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user', frameRate: { ideal: 30, max: 30 } },
        audio: false,
      });
      this.video.srcObject = stream;
      await this.video.play().catch(() => {});
      await new Promise((resolve) => {
        if (this.video.videoWidth) return resolve();
        this.video.onloadedmetadata = () => resolve();
        setTimeout(resolve, 1500);
      });
      this.onStatus('加载手部模型…');
      const vision = await this._loadVision();
      this.landmarker = await this._createLandmarker(vision, true)
        .catch(() => {
          this.usingGPU = false;
          return this._createLandmarker(vision, false);
        })
        .catch(() => this._createLandmarker(vision, true, true))
        .catch(() => this._createLandmarker(vision, false, true));
      if (!this.usingGPU) {
        this.detectInterval = 90;
        this.msg = 'CPU 模式（识别较慢）';
      } else {
        this.msg = 'GPU 模式';
      }
      this.ready = true;
      this.error = null;
      this.onStatus('手掌识别已就绪 · ' + this.msg);
      this._loop();
      return true;
    } catch (e) {
      this.error = e && e.message ? e.message : String(e);
      this.ready = false;
      this.onStatus('摄像头/模型不可用：' + this.error + '（可用键盘 A / L 游玩）');
      return false;
    }
  }

  async _loadVision() {
    try {
      return await import(/* @vite-ignore */ LOCAL.bundle);
    } catch (e) {
      this.msg = '本地模型缺失，使用 CDN';
      this.onStatus('本地模型缺失，改用 CDN…');
      return await import(/* @vite-ignore */ CDN.bundle);
    }
  }

  async _createLandmarker(vision, gpu, useCdn = false) {
    const wasm = useCdn ? CDN.wasm : LOCAL.wasm;
    const model = useCdn ? CDN.model : LOCAL.model;
    const fileset = await vision.FilesetResolver.forVisionTasks(wasm);
    return vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: model, delegate: gpu ? 'GPU' : 'CPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  stop() {
    this.started = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    const s = this.video.srcObject;
    if (s && s.getTracks) s.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
  }

  // ================== 识别循环 ==================
  _loop = () => {
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now();
    if (now - this._lastDetect < this.detectInterval) return;
    if (this.video.readyState < 2 || !this.video.videoWidth) return;
    this._lastDetect = now;
    this.started = true;

    const t0 = performance.now();
    let res = null;
    try {
      res = this.landmarker.detectForVideo(this._src(), t0);
    } catch (e) {
      return;
    }
    const t1 = performance.now();
    this.detectMs = t1 - t0;
    this._lastTimes.push(t0);
    if (this._lastTimes.length > 20) this._lastTimes.shift();
    if (this._lastTimes.length > 3) {
      const dt = (this._lastTimes[this._lastTimes.length - 1] - this._lastTimes[0]) / (this._lastTimes.length - 1);
      this.fps = dt > 0 ? 1000 / dt : 0;
    }
    this._consume(res, t0);
  };

  _src() {
    if (this.usingGPU) return this.video;
    const v = this.video;
    const W = 320;
    const H = Math.round((v.videoHeight / v.videoWidth) * W) || 240;
    if (this._canvas.width !== W || this._canvas.height !== H) {
      this._canvas.width = W;
      this._canvas.height = H;
    }
    this._ctx2d.drawImage(v, 0, 0, W, H);
    return this._canvas;
  }

  _consume(res, t0) {
    const lms = (res && res.landmarks) || [];
    const worlds = (res && res.worldLandmarks) || [];

    // 实际检测到的手，按镜像后的屏幕 x 从左到右排序
    const found = [];
    for (let i = 0; i < lms.length; i++) {
      const lm = lms[i];
      if (!lm || lm.length < 21) continue;
      const P = worlds[i] && worlds[i].length === 21 ? worlds[i] : lm;
      const score = 1 - palmOpenness(P);
      const cx = (lm[0].x + lm[9].x) / 2;
      const cy = (lm[0].y + lm[9].y) / 2;
      found.push({ x: 1 - cx, y: cy, rawX: cx, score });
    }
    found.sort((a, b) => a.x - b.x);

    this.handFound = found.length > 0;

    // 手数变化时复位闭合状态，避免上一只手的「已握拳」卡到新手
    if (found.length !== this._lastCount) {
      this._lastCount = found.length;
      this._st[0].closed = this._st[1].closed = false;
    }

    for (let lane = 0; lane < 2; lane++) {
      // 两只手：左屏幕的手打左列，右手打右列（可交换）。
      // 只有一只手：同一只手同时驱动两列，单手也能完整游玩
      const hand = found.length >= 2 ? found[this.swap ? 1 - lane : lane] : found[0];
      if (!hand) {
        this._st[lane].closed = false;
        this.hands[lane] = { score: 0, closed: false, x: 0.35 + lane * 0.3, y: 0.5, seen: false };
        continue;
      }
      this._step(lane, hand.score, t0);
      this.hands[lane] = {
        score: hand.score,
        closed: this._st[lane].closed,
        x: hand.rawX,
        y: hand.y,
        seen: true,
      };
    }

    this.handList = found.map((h, i) => {
      const lane = found.length >= 2 ? this.swap ? 1 - i : i : -1;
      return {
        lane,
        x: h.rawX,
        y: h.y,
        score: h.score,
        closed: this._st[lane < 0 ? 0 : lane].closed,
      };
    });
  }

  _step(lane, score, now) {
    const st = this._st[lane];
    const hi = this.threshold;
    const lo = this.threshold * 0.55;
    if (!st.closed) {
      // 闭合的瞬间就触发，不等到重新张开，少一帧延迟
      if (score >= hi && now - st.last > 110) {
        st.closed = true;
        st.since = now;
        st.last = now;
        this.events.push({ lane, t: now, strength: score });
        if (this.events.length > 24) this.events.shift();
      }
    } else if (score <= lo) {
      st.closed = false;
    }
  }

  /** 游戏每帧调用，取出并清空握拳事件 */
  drain() {
    if (!this.events.length) return null;
    const out = this.events;
    this.events = [];
    return out;
  }
}
