// ========== 谱面生成（纯逻辑，无副作用） ==========
// 输出：音符（按时间排序，lane 0=左列 / 1=右列）+ 音乐事件（鼓/贝斯/和弦/旋律提示）
import { clamp, mulberry32 } from './util.js';

export const DIFFICULTY = {
  easy: { key: 'easy', label: '简单', bpm: 84, maxLevel: 1, restChance: 0.22, minGap: 0.36, approach: 1.7 },
  normal: { key: 'normal', label: '普通', bpm: 100, maxLevel: 2, restChance: 0.08, minGap: 0.28, approach: 1.4 },
  hard: { key: 'hard', label: '困难', bpm: 126, maxLevel: 3, restChance: 0, minGap: 0.24, approach: 1.15 },
};

// 一个 16 分音符 = 一小格
const PATTERNS = [
  { id: 'q4', level: 1, steps: [[0, 'B'], [8, 'B']] },
  { id: 'q1', level: 1, steps: [[0, 'L'], [4, 'R'], [8, 'L'], [12, 'R']] },
  { id: 'q2', level: 1, steps: [[0, 'R'], [4, 'L'], [8, 'R'], [12, 'L']] },
  { id: 'q3', level: 1, steps: [[0, 'L'], [4, 'L'], [8, 'R'], [12, 'R']] },
  { id: 'e1', level: 2, steps: [[0, 'L'], [2, 'R'], [4, 'L'], [6, 'R'], [8, 'L'], [10, 'R'], [12, 'L'], [14, 'R']] },
  { id: 'e2', level: 2, steps: [[0, 'R'], [2, 'L'], [4, 'R'], [6, 'L'], [8, 'R'], [10, 'L'], [12, 'R'], [14, 'L']] },
  { id: 'call', level: 2, steps: [[0, 'L'], [2, 'L'], [4, 'B'], [8, 'R'], [10, 'R'], [12, 'B']] },
  { id: 'tres', level: 2, steps: [[0, 'B'], [2, 'L'], [4, 'R'], [8, 'B'], [10, 'R'], [12, 'L']] },
  { id: 'sync', level: 3, steps: [[0, 'B'], [3, 'R'], [6, 'L'], [8, 'B'], [11, 'L'], [14, 'R']] },
  { id: 'gallop', level: 3, steps: [[0, 'L'], [2, 'L'], [4, 'R'], [8, 'R'], [10, 'R'], [12, 'L']] },
];

// 曲式：A / B / C / 尾
const PLAN = [
  { name: 'A', bars: 8, pool: ['q1', 'q2', 'q3', 'e1', 'e2'] },
  { name: 'B', bars: 8, pool: ['e1', 'e2', 'call', 'tres', 'q1'] },
  { name: 'C', bars: 6, pool: ['sync', 'gallop', 'e1', 'e2', 'tres'] },
  { name: 'D', bars: 2, pool: ['q1', 'q4'] },
];

const INTRO_BARS = 2;
const BARS = INTRO_BARS + PLAN.reduce((s, p) => s + p.bars, 0);

// 和声：Am - F - C - G（4 小节一循环）
const CHORDS = [
  { name: 'Am', root: 45, pad: [57, 60, 64], tones: [57, 60, 64, 69, 72, 76] },
  { name: 'F', root: 41, pad: [57, 60, 65], tones: [53, 57, 60, 65, 69, 72] },
  { name: 'C', root: 48, pad: [55, 60, 64], tones: [52, 55, 60, 64, 67, 72] },
  { name: 'G', root: 43, pad: [55, 59, 62], tones: [55, 59, 62, 67, 71, 74] },
];

const SCALE_LOW = [57, 60, 62, 64, 67, 69]; // A3 C4 D4 E4 G4 A4
const SCALE_HIGH = [69, 72, 74, 76, 79, 81]; // A4 C5 D5 E5 G5 A5

const LANE_L = 0;
const LANE_R = 1;

function nearestChordTone(pitch, tones, lane) {
  const pool = tones.filter((t) => (lane === LANE_L ? t < 68 : t >= 64));
  const list = pool.length ? pool : tones;
  let best = list[0];
  for (const t of list) if (Math.abs(t - pitch) < Math.abs(best - pitch)) best = t;
  return best;
}

/** 生成一条有走向的旋律线（同一音轨不会原地重复） */
function makeMelodyWalker(rnd) {
  const idx = [2, 2];
  return function pick(lane, chord, strong) {
    const scale = lane === LANE_L ? SCALE_LOW : SCALE_HIGH;
    const dir = rnd() < 0.42 ? 1 : -1; // 略微下降，避免越走越高
    const step = 1 + Math.floor(rnd() * 2);
    let i = clamp(idx[lane] + dir * step, 0, scale.length - 1);
    let pitch = scale[i];
    if (strong) {
      pitch = nearestChordTone(pitch, chord.tones, lane);
      // 把游标挪到最接近该音的位置
      let bi = 0;
      for (let k = 0; k < scale.length; k++) {
        if (Math.abs(scale[k] - pitch) < Math.abs(scale[bi] - pitch)) bi = k;
      }
      i = bi;
    }
    idx[lane] = i;
    return pitch;
  };
}

function pickPattern(rnd, pool, maxLevel, used) {
  const ok = pool
    .map((id) => PATTERNS.find((p) => p.id === id))
    .filter((p) => p && p.level <= maxLevel);
  const list = ok.length ? ok : PATTERNS.filter((p) => p.level === 1);
  let choice = list[Math.floor(rnd() * list.length)];
  // 避免连续两次完全一样
  if (used.lastId === choice.id && list.length > 1) {
    choice = list[(list.indexOf(choice) + 1) % list.length];
  }
  used.lastId = choice.id;
  return choice;
}

function drumBar(bar, section, rnd, t) {
  const out = [];
  const push = (type, step, extra) => out.push({ time: t(bar, step), type, ...extra });

  push('kick', 0, { gain: 1 });
  push('kick', 8, { gain: 0.92 });
  if (section === 'B' || section === 'C') {
    push('kick', 14, { gain: rnd() < 0.6 ? 0.72 : 0.0 });
    if (rnd() < 0.5) push('kick', 6, { gain: 0.6 });
  }
  push('snare', 4, { gain: 0.9 });
  push('snare', 12, { gain: 0.9 });
  if (section === 'C' && rnd() < 0.4) push('snare', 14, { gain: 0.5 });

  const hatSteps = section === 'C' ? [0, 2, 4, 6, 8, 10, 12, 13, 14, 15] : [0, 2, 4, 6, 8, 10, 12, 14];
  hatSteps.forEach((s) => {
    if (s % 2) return;
    push('hat', s, { gain: s % 4 === 0 ? 0.5 : 0.34, open: s % 4 === 2 && section !== 'A' });
  });
  return out;
}

function bassBar(bar, section, chord, t) {
  const riffs = {
    A: [[0, 0], [6, 0], [8, 7], [14, 0]],
    B: [[0, 0], [3, 12], [6, 0], [8, 7], [11, 7], [14, 12]],
    C: [[0, 0], [2, 0], [4, 7], [6, 7], [8, 12], [10, 12], [12, 7], [14, 0]],
    D: [[0, 0], [8, 7]],
  };
  const riff = riffs[section] || riffs.A;
  return riff.map(([step, off]) => ({ time: t(bar, step), type: 'bass', pitch: chord.root + off, dur: 0.2, gain: 0.5 }));
}

/**
 * 生成整首曲子
 * @returns {{notes:Array, events:Array, beats:number[], bpm:number, duration:number, barDur:number, chords:string[]}}
 */
export function buildChart({ difficulty = 'normal', seed = 20261017 } = {}) {
  const diff = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  const rnd = mulberry32(seed);
  const beatDur = 60 / diff.bpm;
  const stepDur = beatDur / 4;
  const barDur = beatDur * 4;

  const notes = [];
  const events = [];
  const beats = [];
  const walk = makeMelodyWalker(rnd);
  const used = { lastId: null };

  // 全局 16 分格编号 -> 时间
  const t = (bar, step) => (bar * 16 + step) * stepDur;

  // ---- 前奏：2 小节节拍器 & 底鼓，给玩家找感觉 ----
  for (let bar = 0; bar < INTRO_BARS; bar++) {
    for (let s = 0; s < 16; s += 4) {
      events.push({ time: t(bar, s), type: 'click', accent: s === 0 });
      beats.push(t(bar, s));
    }
    events.push({ time: t(bar, 0), type: 'kick', gain: 0.9 });
    events.push({ time: t(bar, 8), type: 'kick', gain: 0.75 });
    events.push({ time: t(bar, 0), type: 'pad', pitches: CHORDS[0].pad, dur: barDur * 0.98, gain: 0.04 });
  }

  // ---- 主体 ----
  let bar = INTRO_BARS;
  for (const sec of PLAN) {
    for (let i = 0; i < sec.bars; i++, bar++) {
      const chord = CHORDS[bar % 4];
      events.push(...drumBar(bar, sec.name, rnd, t));
      events.push(...bassBar(bar, sec.name, chord, t));
      events.push({ time: t(bar, 0), type: 'pad', pitches: chord.pad, dur: barDur * 0.98, gain: 0.05 });

      for (let s = 0; s < 16; s += 4) beats.push(t(bar, s));

      // 休息小节：简单难度偶尔空一拍
      if (rnd() < diff.restChance) continue;

      const pat = pickPattern(rnd, sec.pool, diff.maxLevel, used);
      const strongStep = sec.name === 'C' ? 4 : 8;

      for (const [step, laneTag] of pat.steps) {
        const time = t(bar, step);
        const strong = step % strongStep === 0;
        const lanes = laneTag === 'B' ? [LANE_L, LANE_R] : [laneTag === 'L' ? LANE_L : LANE_R];

        for (const lane of lanes) {
          // 同轨最小间隔检查
          let tooClose = false;
          for (let k = notes.length - 1; k >= 0 && notes.length - k < 8; k--) {
            const n = notes[k];
            if (n.lane === lane && Math.abs(n.time - time) < diff.minGap) { tooClose = true; break; }
          }
          if (tooClose) continue;

          const pitch = walk(lane, chord, strong);
          const note = {
            id: notes.length,
            time,
            lane,
            pitch,
            bar,
            section: sec.name,
            chord: chord.name,
            state: 'pending',
          };
          notes.push(note);
          // 旋律提示音（音量很低，保证节奏骨架完整；可在设置里关掉）
          events.push({ time: note.time, type: 'guide', pitch, gain: 0.05, noteId: note.id });
        }
      }
    }
  }

  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  events.sort((a, b) => a.time - b.time);

  const duration = BARS * barDur;

  return {
    difficulty: diff.key,
    bpm: diff.bpm,
    beatDur,
    stepDur,
    barDur,
    bars: BARS,
    duration,
    approach: diff.approach,
    notes,
    events,
    beats,
    chords: Array.from({ length: Math.ceil(BARS / 4) }, (_, i) => CHORDS[i % 4].name),
    title: `Am-F-C-G · ${diff.label} ${diff.bpm}BPM`,
  };
}

/** 校准用的小谱面：8 拍，每拍一个双轨音符 */
export function buildCalibrationChart({ bpm = 100, seed = 7 } = {}) {
  const rnd = mulberry32(seed);
  const beatDur = 60 / bpm;
  const stepDur = beatDur / 4;
  const t = (bar, step) => (bar * 16 + step) * stepDur;
  const notes = [];
  const events = [];
  const beats = [];
  const chord = CHORDS[0];

  for (let bar = 0; bar < 2; bar++) {
    for (let s = 0; s < 16; s += 4) {
      events.push({ time: t(bar, s), type: 'click', accent: s === 0 });
      beats.push(t(bar, s));
    }
    events.push({ time: t(bar, 0), type: 'kick', gain: 0.9 });
    events.push({ time: t(bar, 0), type: 'pad', pitches: chord.pad, dur: barDurOf(beatDur) * 0.98, gain: 0.045 });
  }
  // 第三、四小节：每拍一个双轨音符
  for (let bar = 2; bar < 4; bar++) {
    for (let s = 0; s < 16; s += 4) {
      const time = t(bar, s);
      beats.push(time);
      events.push({ time, type: 'kick', gain: 0.85 });
      events.push({ time, type: 'hat', gain: 0.25 });
      const pL = SCALE_LOW[1 + Math.floor(rnd() * 3)];
      const pR = SCALE_HIGH[1 + Math.floor(rnd() * 3)];
      notes.push({ id: notes.length, time, lane: LANE_L, pitch: pL, bar, state: 'pending', calib: true });
      notes.push({ id: notes.length, time, lane: LANE_R, pitch: pR, bar, state: 'pending', calib: true });
      events.push({ time, type: 'guide', pitch: pL, gain: 0.05 });
      events.push({ time, type: 'guide', pitch: pR, gain: 0.04 });
    }
  }
  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  events.sort((a, b) => a.time - b.time);
  return {
    difficulty: 'calib',
    bpm, beatDur, stepDur, barDur: barDurOf(beatDur),
    bars: 4, duration: 4 * barDurOf(beatDur), approach: 1.5,
    notes, events, beats, chords: ['Am'], title: '校准', calibBeats: 8,
  };
}

function barDurOf(beatDur) {
  return beatDur * 4;
}

export const CHART_PLAN_INFO = { INTRO_BARS, BARS, PLAN };
