/* Анализатор разгонов Scanmatic SM2 (OBD-II) + CSV fallback */

const COLORS = [
  "#3d9cf0", "#2bb673", "#e0a84a", "#e35d5d", "#b07cff",
  "#35c5c5", "#f07a4a", "#8bbc4f", "#5b8def", "#d45db5",
];

const TIME_KEYS = [
  "время", "time", "t", "сек", "sec", "timestamp", "дата", "относительное время",
];
const RPM_KEYS = [
  "оборот", "rpm", "об/мин", "engine speed", "скорость вращения колен",
  "частота вращения", "коленвал",
];
const PEDAL_KEYS = [
  "педаль", "pedal", "accelerator", "app", "газ", "gas", "акселер",
  "положение педали", "запрос момента", "driver demand", "tps request",
];
const SPEED_KEYS = [
  "скорость", "speed", "vss", "vehicle speed", "км/ч", "km/h", "kph",
];
const THROTTLE_KEYS = ["дроссел", "throttle", "thr", "tps"];

/** @type {import('chart.js').Chart | null} */
let accelChartClassic = null;
/** @type {import('chart.js').Chart | null} */
let accelChartLink = null;
/** @type {import('chart.js').Chart | null} */
let accelChartDyno = null;
/** @type {import('chart.js').Chart | null} */
let overviewChart = null;

/** @type {Array<LogFile>} */
let logs = [];
/** SM2-сессии, чтобы фильтр без разгонов не терял файлы. */
let sm2Sources = [];
let colorIdx = 0;
/** @type {"classic" | "link" | "dyno"} */
let accelTab = "link";
/**
 * @typedef {{ id: string, name: string, headers: string[], rows: number[][],
 *   timeCol: number, rpmCol: number, pedalCol: number, speedCol: number,
 *   pulls: Pull[], colorBase: string }} LogFile
 * @typedef {{ id: string, logId: string, name: string, start: number, end: number,
 *   t0: number, t1: number, rpm0: number, rpm1: number, selected: boolean,
 *   color: string, points: AccelPoint[], metrics: object }} Pull
 * @typedef {{ t: number, rpm: number, pedal: number, speed: number|null,
 *   rpmAccel: number, vehAccel: number|null }} AccelPoint
 */

const $ = (id) => document.getElementById(id);

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[\[\]]/g, "")
    .trim();
}

function scoreHeader(header, keys) {
  const h = norm(header);
  let best = 0;
  for (const k of keys) {
    if (h === k) best = Math.max(best, 100);
    else if (h.includes(k)) best = Math.max(best, 60 + Math.min(20, k.length));
  }
  return best;
}

function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || "";
  const counts = {
    ";": (first.match(/;/g) || []).length,
    ",": (first.match(/,/g) || []).length,
    "\t": (first.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ";";
}

function parseNumber(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s || s === "-" || s === "—") return NaN;
  s = s.replace(/\s/g, "").replace(/"/g, "");
  if (s.includes(",") && s.includes(".")) {
    // 1,234.56 or 1.234,56
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function splitCsvLine(line, delim) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (c === delim && !q) {
      out.push(cur); cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseCsvText(text) {
  const cleaned = text.replace(/^\uFEFF/, "");
  const delim = detectDelimiter(cleaned);
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw new Error("Пустой файл");

  /** @type {number|null} */
  let sampleDt = null;

  // Skip metadata-like preamble (OP-COM style etc.) until a header-looking line
  let headerIdx = 0;
  for (let i = 0; i < Math.min(30, lines.length); i++) {
    const cols = splitCsvLine(lines[i], delim);
    // SPTronic CSVV2: CSVV2;...;dt;...
    if (/^csvv2/i.test((cols[0] || "").trim())) {
      const maybeDt = parseNumber(cols[8]);
      if (Number.isFinite(maybeDt) && maybeDt > 0 && maybeDt < 1) sampleDt = maybeDt;
      continue;
    }
    const looksHeader = cols.some((c) =>
      scoreHeader(c, TIME_KEYS) + scoreHeader(c, RPM_KEYS) + scoreHeader(c, PEDAL_KEYS) > 40
    );
    const numericRatio = cols.filter((c) => Number.isFinite(parseNumber(c))).length / Math.max(1, cols.length);
    if (looksHeader && numericRatio < 0.6) { headerIdx = i; break; }
    if (i === 0 && cols.length >= 2 && numericRatio < 0.5) headerIdx = 0;
  }

  let headers = splitCsvLine(lines[headerIdx], delim).map((h) => h.trim());
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i], delim);
    if (parts.length < 2) continue;
    const nums = headers.map((_, idx) => parseNumber(parts[idx]));
    if (nums.every((n) => !Number.isFinite(n))) continue;
    rows.push(nums);
  }
  if (!rows.length) throw new Error("Не удалось прочитать строки данных");

  // If no time column — synthesize from sample rate / 20 Hz
  const hasTime = headers.some((h) => scoreHeader(h, TIME_KEYS) >= 20);
  if (!hasTime) {
    const dt = sampleDt || 0.05;
    headers = ["Time", ...headers];
    for (let i = 0; i < rows.length; i++) rows[i] = [i * dt, ...rows[i]];
  }
  return { headers, rows, delim };
}

function looksLikeScanmatikCsv(headers) {
  const rpm = headers.some((h) => scoreHeader(h, RPM_KEYS) >= 40);
  const pedal = headers.some((h) => scoreHeader(h, [...PEDAL_KEYS, ...THROTTLE_KEYS]) >= 40);
  return rpm && pedal;
}

function pickColumns(headers) {
  const scored = (keys) => headers
    .map((h, i) => ({ i, s: scoreHeader(h, keys), h }))
    .sort((a, b) => b.s - a.s);

  const time = scored(TIME_KEYS);
  const rpm = scored(RPM_KEYS);
  let pedal = scored(PEDAL_KEYS);
  if (!pedal[0] || pedal[0].s < 40) {
    // fallback: throttle / gas if pedal not found
    pedal = scored([...PEDAL_KEYS, ...THROTTLE_KEYS, "gas"]);
  }
  const speed = scored(SPEED_KEYS);

  const used = new Set();
  const take = (list, minScore = 20) => {
    for (const x of list) {
      if (x.s >= minScore && !used.has(x.i)) { used.add(x.i); return x.i; }
    }
    return -1;
  };

  // Prefer first column as time if named Time / Время weakly
  let timeCol = take(time, 20);
  if (timeCol < 0 && /time|врем/i.test(headers[0] || "")) timeCol = 0;

  const rpmCol = take(rpm, 20);
  const pedalCol = take(pedal, 20);
  const speedCol = take(speed, 40);

  return { timeCol, rpmCol, pedalCol, speedCol };
}

function movingAverage(arr, window) {
  const w = Math.max(1, window | 0);
  if (w <= 1) return arr.slice();
  const half = Math.floor(w / 2);
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < arr.length && Number.isFinite(arr[j])) { s += arr[j]; n++; }
    }
    out[i] = n ? s / n : NaN;
  }
  return out;
}

function derivative(y, t) {
  const out = new Array(y.length).fill(NaN);
  for (let i = 1; i < y.length; i++) {
    const dt = t[i] - t[i - 1];
    if (dt > 1e-6 && Number.isFinite(y[i]) && Number.isFinite(y[i - 1])) {
      out[i] = (y[i] - y[i - 1]) / dt;
    }
  }
  if (out.length > 1) out[0] = out[1];
  return out;
}

/**
 * Как Link Math Block: dt(a, window) / window
 * т.е. уравнение Link «dt(a,0.2)*5» = (a(t)−a(t−0.2)) / 0.2
 */
function linkDtPerSec(values, time, windowSec = 0.2) {
  const w = Math.max(0.05, Number(windowSec) || 0.2);
  const out = new Array(values.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]) || !Number.isFinite(time[i])) continue;
    const tTarget = time[i] - w;
    if (tTarget < time[0]) continue;
    while (j + 1 < i && time[j + 1] <= tTarget) j++;
    let yPast = values[j];
    if (j + 1 < values.length && time[j + 1] > time[j]) {
      const u = (tTarget - time[j]) / (time[j + 1] - time[j]);
      if (u >= 0 && u <= 1 && Number.isFinite(values[j + 1])) {
        yPast = values[j] + u * (values[j + 1] - values[j]);
      }
    }
    if (!Number.isFinite(yPast)) continue;
    out[i] = (values[i] - yPast) / w;
  }
  return out;
}

/**
 * Наклон RPM по МНК за окно lookback — устойчив к ступенькам OBD.
 */
function rollingSlopePerSec(time, values, windowSec = 0.45) {
  const span = time.length >= 2 ? time[time.length - 1] - time[0] : 0;
  let w = Math.max(0.15, Number(windowSec) || 0.45);
  if (span > 0) w = Math.min(w, Math.max(0.15, span * 0.45));
  const out = new Array(values.length).fill(NaN);
  let left = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(time[i]) || !Number.isFinite(values[i])) continue;
    while (left < i && time[i] - time[left] > w) left++;
    let n = 0;
    let sumT = 0;
    let sumY = 0;
    let sumTT = 0;
    let sumTY = 0;
    for (let k = left; k <= i; k++) {
      const t = time[k];
      const y = values[k];
      if (!Number.isFinite(t) || !Number.isFinite(y)) continue;
      n++;
      sumT += t;
      sumY += y;
      sumTT += t * t;
      sumTY += t * y;
    }
    if (n < 2) continue;
    const den = n * sumTT - sumT * sumT;
    if (Math.abs(den) < 1e-12) {
      // все точки с одним временем — fallback на соседнюю
      if (i > 0) {
        const dt = time[i] - time[i - 1];
        if (dt > 1e-6) {
          const s = (values[i] - values[i - 1]) / dt;
          out[i] = s > 0 ? s : NaN;
        }
      }
      continue;
    }
    const slope = (n * sumTY - sumT * sumY) / den;
    out[i] = slope > 0 ? slope : NaN;
  }
  return out;
}

function computeAccelSeries(time, rpm, opts, mode) {
  const dtWin = opts.dtWindow ?? 0.2;
  const win = Math.max(1, opts.smoothWindow | 0);
  const odd = win % 2 ? win : win + 1;

  // classic = как в V1 OK: сглаживание → dY/dt → сглаживание
  if (mode === "classic") {
    const simple = movingAverage(derivative(movingAverage(rpm, odd), time), odd);
    return time.map((_, i) => {
      const v = simple[i];
      return Number.isFinite(v) && v > 0 ? v : NaN;
    });
  }

  // link: Math Block dt + лёгкая регрессия для устойчивости на редком OBD
  const link = linkDtPerSec(rpm, time, dtWin);
  const regWin = Math.max(0.25, dtWin * 2);
  const reg = rollingSlopePerSec(rpm, time, regWin);
  return time.map((_, i) => {
    const l = link[i];
    const r = reg[i];
    let v = NaN;
    if (Number.isFinite(l) && Number.isFinite(r)) v = 0.4 * l + 0.6 * r;
    else if (Number.isFinite(r)) v = r;
    else if (Number.isFinite(l)) v = l;
    return Number.isFinite(v) && v > 0 ? v : NaN;
  });
}

function medianOf(arr) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/**
 * Узнаваемая полка: широкие корзины → медиана → плотная сетка → сглаживание.
 * @param {{ minY?: number, iqrFloor?: number, smoothHalf?: number }} [opts]
 */
function shelfCurveVsRpm(rawPts, binRpm = 250, opts = {}) {
  const minY = opts.minY ?? 0;
  const iqrFloor = opts.iqrFloor ?? 80;
  const pts = rawPts
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.y > minY)
    .sort((a, b) => a.x - b.x);
  if (pts.length < 3) return pts.map((p) => ({ x: p.x, y: p.y }));

  const ys = pts.map((p) => p.y).sort((a, b) => a - b);
  const q1 = ys[Math.floor(ys.length * 0.2)];
  const q3 = ys[Math.floor(ys.length * 0.8)];
  const iqr = Math.max(iqrFloor, q3 - q1);
  const hi = q3 + 1.25 * iqr;
  const lo = Math.max(0, q1 - 1.0 * iqr);
  const use = pts.filter((p) => p.y >= lo && p.y <= hi);
  const src = use.length >= 4 ? use : pts;

  const bin = Math.max(150, binRpm);
  const buckets = new Map();
  for (const p of src) {
    const key = Math.round(p.x / bin) * bin;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p.y);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const anchors = [];
  for (const k of keys) {
    const vals = buckets.get(k);
    if (!vals || !vals.length) continue;
    anchors.push({ x: k, y: medianOf(vals) });
  }
  if (anchors.length < 2) return src.map((p) => ({ x: p.x, y: p.y }));

  const x0 = anchors[0].x;
  const x1 = anchors[anchors.length - 1].x;
  const dense = [];
  let ai = 0;
  for (let x = x0; x <= x1 + 1e-6; x += 50) {
    while (ai + 1 < anchors.length && anchors[ai + 1].x < x) ai++;
    const a = anchors[ai];
    const b = anchors[Math.min(ai + 1, anchors.length - 1)];
    let y = a.y;
    if (b.x > a.x) {
      const u = (x - a.x) / (b.x - a.x);
      y = a.y + Math.max(0, Math.min(1, u)) * (b.y - a.y);
    }
    dense.push({ x, y });
  }

  const half = opts.smoothHalf ?? 4;
  const out = dense.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 0; i < dense.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= dense.length) continue;
      s += dense[j].y;
      n++;
    }
    out[i].y = n ? s / n : dense[i].y;
  }
  return out;
}

/**
 * Virtual Dyno для одной машины / одной дороги (SAE / VD):
 *   P/m = a·v  [Вт/кг] — удельная мощность ускорения; при той же массе ≡ сравнение WHP.
 * a = dv/dt (Link+регрессия). v — OBD км/ч; редкую скорость достраиваем по передаче v∝RPM.
 * Без скорости: P_idx ∝ (dRPM/dt)·RPM (форма мощности на валу в той же передаче).
 */
function attachDynoIndex(points, opts = {}) {
  if (!points?.length) return { source: "none", gearKv: NaN, unit: "—" };
  const dtWin = opts.dtWindow ?? 0.2;
  const win = Math.max(1, opts.smoothWindow | 0);

  const ratios = [];
  for (const p of points) {
    if (Number.isFinite(p.speed) && p.speed > 5 && Number.isFinite(p.rpm) && p.rpm > 500) {
      ratios.push(p.rpm / p.speed);
    }
  }
  const gearKv = medianOf(ratios);
  const time = points.map((p) => p.t);
  const vMs = points.map((p) => {
    if (Number.isFinite(p.speed) && p.speed > 0) return p.speed / 3.6;
    if (Number.isFinite(gearKv) && gearKv > 1 && Number.isFinite(p.rpm)) {
      return (p.rpm / gearKv) / 3.6;
    }
    return NaN;
  });
  const covered = vMs.filter((v) => Number.isFinite(v) && v > 0.5).length;
  const coverage = covered / points.length;

  let source = "rpm";
  let unit = "отн.";
  if (coverage >= 0.35) {
    const aLink = computeAccelSeries(time, vMs, { dtWindow: dtWin, smoothWindow: win }, "link");
    const aCl = computeAccelSeries(time, vMs, { dtWindow: dtWin, smoothWindow: win }, "classic");
    for (let i = 0; i < points.length; i++) {
      const a = Number.isFinite(aLink[i]) && aLink[i] > 0
        ? aLink[i]
        : (Number.isFinite(aCl[i]) && aCl[i] > 0 ? aCl[i] : NaN);
      const v = vMs[i];
      points[i].vMs = v;
      points[i].fSpec = Number.isFinite(a) ? a : NaN;
      points[i].pSpec = Number.isFinite(a) && Number.isFinite(v) && v > 0.5 ? a * v : NaN;
      if (!Number.isFinite(points[i].vehAccel) && Number.isFinite(aCl[i])) points[i].vehAccel = aCl[i];
      if (!Number.isFinite(points[i].vehAccelLink) && Number.isFinite(aLink[i])) points[i].vehAccelLink = aLink[i];
    }
    const usedGearFill = points.some((p) => !(Number.isFinite(p.speed) && p.speed > 0)) && Number.isFinite(gearKv);
    source = usedGearFill ? "speed+gear" : "speed";
    unit = "Вт/кг";
  } else {
    // P ∝ α·ω; нормировка /5e5 → типичный пик легкового ~8–25 (сравнимо с Вт/кг)
    const C = 500000;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const alpha = Number.isFinite(p.rpmAccelLink) && p.rpmAccelLink > 0
        ? p.rpmAccelLink
        : (Number.isFinite(p.rpmAccel) && p.rpmAccel > 0 ? p.rpmAccel : NaN);
      p.vMs = Number.isFinite(vMs[i]) ? vMs[i] : NaN;
      p.fSpec = Number.isFinite(alpha) ? alpha / 1000 : NaN;
      p.pSpec = Number.isFinite(alpha) && p.rpm > 0 ? (alpha * p.rpm) / C : NaN;
    }
    source = "rpm";
    unit = "отн.";
  }

  const valid = points.filter((p) => Number.isFinite(p.pSpec) && p.pSpec > 0);
  const peak = valid.length ? Math.max(...valid.map((p) => p.pSpec)) : NaN;
  const avg = valid.length ? valid.reduce((s, p) => s + p.pSpec, 0) / valid.length : NaN;
  return {
    source,
    gearKv,
    unit,
    metricsDyno: { peak, avg, n: valid.length, unit, source },
  };
}

/** Заполнить короткие NaN в ряде (время в секундах, дыра <1.2 с). */
function interpFiniteSeries(time, y) {
  const out = y ? y.slice() : [];
  if (!time || out.length !== time.length) return out;
  for (let i = 1; i < out.length; i++) {
    if (Number.isFinite(out[i])) continue;
    if (!Number.isFinite(out[i - 1])) continue;
    let j = i + 1;
    while (j < out.length && !Number.isFinite(out[j])) j++;
    if (j >= out.length) break;
    const span = time[j] - time[i - 1];
    if (!(span > 0) || span > 1.2) {
      i = j;
      continue;
    }
    for (let k = i; k < j; k++) {
      const u = (time[k] - time[i - 1]) / span;
      out[k] = out[i - 1] + u * (out[j] - out[i - 1]);
    }
    i = j;
  }
  return out;
}

/**
 * Уточнение по скорости при жёсткой передаче: RPM ≈ k · VSS.
 * dRPM/dt смешивается с k·dv/dt — меньше ступенек OBD.
 * На АКПП гидротрансформатор проскальзывает (k плавает) — галочку снять.
 */
function applySpeedGearLock(points, opts = {}) {
  const meta = {
    applied: false,
    usable: false,
    locked: false,
    gearKv: NaN,
    cv: NaN,
    coverage: 0,
    weight: 0,
  };
  if (!points?.length) return meta;

  const time = points.map((p) => p.t);
  const rpm = points.map((p) => p.rpm);
  let speed = points.map((p) => (Number.isFinite(p.speed) ? p.speed : NaN));
  speed = interpFiniteSeries(time, speed);
  for (let i = 0; i < points.length; i++) {
    if (Number.isFinite(speed[i])) points[i].speed = speed[i];
  }

  const ratios = [];
  for (let i = 0; i < points.length; i++) {
    if (speed[i] > 8 && rpm[i] > 800) ratios.push(rpm[i] / speed[i]);
  }
  meta.coverage = ratios.length / points.length;
  meta.gearKv = medianOf(ratios);
  if (ratios.length >= 4 && meta.gearKv > 1) {
    const varr = ratios.reduce((s, x) => s + (x - meta.gearKv) ** 2, 0) / ratios.length;
    meta.cv = Math.sqrt(varr) / meta.gearKv;
  }
  meta.usable = meta.coverage >= 0.4 && meta.gearKv > 8 && meta.gearKv < 250;
  meta.locked = meta.usable && Number.isFinite(meta.cv) && meta.cv < 0.12;

  const dtWin = opts.dtWindow ?? 0.2;
  const win = Math.max(1, opts.smoothWindow | 0);
  const vMs = speed.map((s) => (s > 0 ? s / 3.6 : NaN));
  const aCl = computeAccelSeries(time, vMs, { dtWindow: dtWin, smoothWindow: win }, "classic");
  const aLk = computeAccelSeries(time, vMs, { dtWindow: dtWin, smoothWindow: win }, "link");
  for (let i = 0; i < points.length; i++) {
    if (!Number.isFinite(points[i].vehAccel) && Number.isFinite(aCl[i])) points[i].vehAccel = aCl[i];
    if (!Number.isFinite(points[i].vehAccelLink) && Number.isFinite(aLk[i])) points[i].vehAccelLink = aLk[i];
  }

  if (!opts.speedLock || !meta.usable) return meta;

  const rpmEq = speed.map((s) => (s > 3 ? s * meta.gearKv : NaN));
  const eqCl = computeAccelSeries(time, rpmEq, { dtWindow: dtWin, smoothWindow: win }, "classic");
  const eqLk = computeAccelSeries(time, rpmEq, { dtWindow: dtWin, smoothWindow: win }, "link");
  const w = meta.locked ? 0.62 : 0.35;
  const blend = (a, b) => {
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return (1 - w) * a + w * b;
    if (Number.isFinite(b) && b > 0) return b;
    return a;
  };
  for (let i = 0; i < points.length; i++) {
    points[i].rpmAccelRaw = points[i].rpmAccel;
    points[i].rpmAccelLinkRaw = points[i].rpmAccelLink;
    points[i].rpmAccel = blend(points[i].rpmAccel, eqCl[i]);
    points[i].rpmAccelLink = blend(points[i].rpmAccelLink, eqLk[i]);
    points[i].rpmEq = rpmEq[i];
  }
  meta.applied = true;
  meta.weight = w;
  return meta;
}

function pullHasUsableSpeed(pull) {
  if (pullSpeedLooksFrozen(pull)) return false;
  if (pull?.speedLock?.usable || pull?.speedLock?.applied) return true;
  const pts = pull?.points;
  if (pts?.length) {
    const n = pts.filter((p) => Number.isFinite(p.speed) && p.speed > 8).length;
    return n / pts.length >= 0.4;
  }
  const sp = pull?.overview?.speed;
  if (!sp?.length) return false;
  const n = sp.filter((s) => Number.isFinite(s) && s > 8).length;
  return n / sp.length >= 0.4;
}

function pullSpeedLooksFrozen(pull) {
  if (speedArrayLooksFrozen(pull?.overview?.speed, pull)) return true;
  if (pull?.points?.length) {
    return speedArrayLooksFrozen(pull.points.map((p) => p.speed), pull);
  }
  return false;
}

function speedArrayLooksFrozen(src, pull) {
  const sp = (src || []).filter((s) => Number.isFinite(s) && s > 0);
  if (sp.length < 3) return false;
  const span = Math.max(...sp) - Math.min(...sp);
  const rpmSpan = Math.abs((pull.rpm1 || 0) - (pull.rpm0 || 0));
  const mid = sp.slice().sort((a, b) => a - b)[Math.floor(sp.length / 2)];
  const frozen = sp.filter((s) => Math.abs(s - mid) < 1.5).length / sp.length;
  if (rpmSpan > 400 && span < 5) return true;
  if (Math.abs(mid - (219 / 255) * 100) < 1.3 && span < 8) return true;
  return frozen > 0.8 && span < 10 && rpmSpan > 300;
}

/** Для расчёта: убрать застывший/педальный «VSS», не трогая ряд на обзоре. */
function sanitizePointsSpeed(points) {
  if (typeof sm2SanitizeSpeed !== "function" || !points?.length) return;
  const tmp = points.map((p) => ({ t: p.t, rpm: p.rpm, pedal: p.pedal, speed: p.speed }));
  sm2SanitizeSpeed(tmp);
  for (let i = 0; i < points.length; i++) points[i].speed = tmp[i].speed;
}

function timeAtValue(time, values, target) {
  if (!time?.length || !values?.length || !Number.isFinite(target)) return null;
  if (Number.isFinite(values[0]) && values[0] >= target) return time[0];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (b < target) continue;
    if (b <= a) return time[i];
    const u = (target - a) / (b - a);
    return time[i - 1] + u * (time[i] - time[i - 1]);
  }
  return null;
}

/** Убрать стартовый переход WOT (скачок OBD / прогрев окна). */
function trimPullTransient(points, warmSec = 0.35) {
  if (!points.length) return [];
  const t0 = points[0].t;
  const cut = points.filter((p) => (p.t - t0) >= warmSec);
  return cut.length >= 5 ? cut : points;
}

function getSeries(log) {
  const t = log.rows.map((r) => r[log.timeCol]);
  const rpm = log.rows.map((r) => r[log.rpmCol]);
  const pedal = log.rows.map((r) => r[log.pedalCol]);
  const speed = log.speedCol >= 0 ? log.rows.map((r) => r[log.speedCol]) : null;

  // Normalize time: if looks like absolute timestamps far apart, keep; if ms indices — ok
  // If time is not monotonic ascending, synthesize from row index * median dt
  let time = t.slice();
  let mono = true;
  for (let i = 1; i < time.length; i++) {
    if (!(time[i] > time[i - 1])) { mono = false; break; }
  }
  if (!mono || time.some((x) => !Number.isFinite(x))) {
    time = time.map((_, i) => i * 0.05); // 20 Hz fallback
  } else {
    // Convert ms → s if values look like milliseconds
    const span = time[time.length - 1] - time[0];
    if (span > 10000 && span / time.length > 5) {
      time = time.map((x) => x / 1000);
    }
  }

  // Pedal scale: if values mostly 0..1, convert to %
  const finitePedal = pedal.filter((v) => Number.isFinite(v));
  const pMax = Math.max(...finitePedal, 0);
  let pedalPct = pedal.slice();
  if (pMax > 0 && pMax <= 1.5) pedalPct = pedal.map((v) => v * 100);
  else if (pMax > 100 && pMax <= 1023) pedalPct = pedal.map((v) => (v / 1023) * 100);

  let speedOut = speed;
  if (speedOut) {
    speedOut = interpFiniteSeries(time, speedOut.map((s) => (Number.isFinite(s) ? s : NaN)));
  }

  return { time, rpm, pedal: pedalPct, speed: speedOut };
}

function findPulls(log, opts) {
  const { time, rpm, pedal, speed } = getSeries(log);
  const dtWin = opts.dtWindow ?? 0.2;
  const win = Math.max(1, opts.smoothWindow | 0);

  const rpmAccelClassic = computeAccelSeries(time, rpm, { dtWindow: dtWin, smoothWindow: win }, "classic");
  const rpmAccelLink = computeAccelSeries(time, rpm, { dtWindow: dtWin, smoothWindow: win }, "link");

  let vehAccelClassic = null;
  let vehAccelLink = null;
  if (speed) {
    const v = speed.map((s) => (Number.isFinite(s) ? s / 3.6 : NaN));
    vehAccelClassic = computeAccelSeries(time, v, { dtWindow: dtWin, smoothWindow: win }, "classic");
    vehAccelLink = computeAccelSeries(time, v, { dtWindow: dtWin, smoothWindow: win }, "link");
  }

  const series = time.map((t, i) => ({
    t, rpm: rpm[i], pedal: pedal[i], speed: speed ? speed[i] : null,
  }));
  const segs = (typeof sm2FindAllWotPulls === "function")
    ? sm2FindAllWotPulls(series, sm2WotOpts(opts))
    : [];

  /** @type {Pull[]} */
  const pulls = [];
  for (const seg of segs) {
    const a = Number.isInteger(seg.a) ? seg.a : 0;
    const b = Number.isInteger(seg.b) ? seg.b : time.length - 1;
    if (b - a < 2) continue;
    const r0 = rpm[a];
    const r1 = rpm[b];
    const points = [];
    for (let k = a; k <= b; k++) {
      const prevRpm = k > a ? rpm[k - 1] : rpm[k];
      const dip = (typeof SM2_OBD_DIP === "number") ? SM2_OBD_DIP : 80;
      if (k > a && rpm[k] + dip < prevRpm) continue;
      if (!Number.isFinite(rpm[k])) continue;
      const aClassic = rpmAccelClassic[k];
      const aLink = rpmAccelLink[k];
      points.push({
        t: time[k] - time[a],
        rpm: rpm[k],
        pedal: pedal[k],
        speed: speed ? speed[k] : null,
        rpmAccel: aClassic,
        rpmAccelLink: aLink,
        vehAccel: vehAccelClassic ? vehAccelClassic[k] : null,
        vehAccelLink: vehAccelLink ? vehAccelLink[k] : null,
      });
    }
    if (points.length < 3) continue;

    sanitizePointsSpeed(points);
    const dyno = attachDynoIndex(points, { dtWindow: dtWin, smoothWindow: win });
    const lock = applySpeedGearLock(points, opts);
    pulls.push({
      id: `${log.id}-p${pulls.length + 1}`,
      logId: log.id,
      name: segs.length > 1 ? `${log.name} · #${pulls.length + 1}` : (log.name || `WOT #${pulls.length + 1}`),
      start: a,
      end: b,
      t0: time[a],
      t1: time[b],
      rpm0: r0,
      rpm1: r1,
      selected: true,
      color: COLORS[colorIdx++ % COLORS.length],
      points,
      metrics: computeMetrics(points, "classic"),
      metricsLink: computeMetrics(points, "link"),
      metricsDyno: dyno.metricsDyno,
      dynoSource: dyno.source,
      dynoUnit: dyno.unit,
      gearKv: Number.isFinite(lock.gearKv) ? lock.gearKv : dyno.gearKv,
      speedLock: lock,
      overview: {
        time: time.slice(a, b + 1),
        rpm: rpm.slice(a, b + 1),
        pedal: pedal.slice(a, b + 1),
        speed: speed ? speed.slice(a, b + 1) : null,
        tOffset: time[a],
      },
    });
  }

  return pulls;
}

function computeMetrics(points, mode = "classic") {
  const key = mode === "link" ? "rpmAccelLink" : "rpmAccel";
  const valid = points.filter((p) => Number.isFinite(p.rpm) && Number.isFinite(p[key]) && p[key] > 0);
  if (!valid.length) {
    return { peak: NaN, avg: NaN, t2k5k: NaN, duration: 0, rpmSpan: 0 };
  }
  const peak = Math.max(...valid.map((p) => p[key]));
  const avg = valid.reduce((s, p) => s + p[key], 0) / valid.length;
  const duration = points[points.length - 1].t - points[0].t;
  const rpmSpan = points[points.length - 1].rpm - points[0].rpm;

  // time from ~2000 to ~5000 rpm (nearest samples)
  const near = (target) => {
    let best = null, bestD = Infinity;
    for (const p of points) {
      const d = Math.abs(p.rpm - target);
      if (d < bestD) { bestD = d; best = p; }
    }
    return bestD < 250 ? best : null;
  };
  const p2 = near(2000);
  const p5 = near(5000);
  let t2k5k = NaN;
  if (p2 && p5 && p5.t > p2.t) t2k5k = p5.t - p2.t;

  const peakVehKey = mode === "link" ? "vehAccelLink" : "vehAccel";
  const peakVeh = points
    .map((p) => p[peakVehKey])
    .filter((v) => Number.isFinite(v));
  return {
    peak,
    avg,
    t2k5k,
    duration,
    rpmSpan,
    peakVeh: peakVeh.length ? Math.max(...peakVeh) : NaN,
  };
}

async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const tryEncodings = ["utf-8", "windows-1251"];
  let best = { text: "", score: -1, enc: "utf-8" };
  for (const enc of tryEncodings) {
    try {
      const text = new TextDecoder(enc, { fatal: false }).decode(buf);
      // score: fewer replacement chars + presence of known words
      const bad = (text.match(/\uFFFD/g) || []).length;
      const good =
        (text.match(/оборот|педаль|время|rpm|pedal|time|газ|throttle/gi) || []).length;
      const score = good * 10 - bad;
      if (score > best.score) best = { text, score, enc };
    } catch (_) { /* ignore */ }
  }
  return best.text;
}

function optsFromUi() {
  const wotFloor = Number($("wotFloor")?.value);
  const minRpmGain = Number($("minRpmGain")?.value);
  return {
    wotFloor: Number.isFinite(wotFloor) ? wotFloor : 70,
    pedalMin: Number.isFinite(wotFloor) ? wotFloor : 70,
    minRpmGain: Math.max(4000, Number.isFinite(minRpmGain) ? minRpmGain : 4000),
    minDuration: Number($("minDuration").value),
    dtWindow: Number($("dtWindow")?.value) || 0.2,
    smoothWindow: Number($("smoothWindow")?.value) || 5,
    metric: $("metric").value,
    speedLock: !!$("speedLock")?.checked,
  };
}

function sm2WotOpts(opts) {
  return {
    wotFloor: opts.wotFloor ?? opts.pedalMin ?? 70,
    pedalMin: opts.wotFloor ?? opts.pedalMin ?? 70,
    minRpmGain: Math.max(4000, opts.minRpmGain ?? 4000),
    minDuration: opts.minDuration,
  };
}

function addWotsFromSession(session, fileName, opts) {
  const wots = sm2SessionToWotPulls(session, sm2WotOpts(opts));
  let added = 0;
  for (const wot of wots) {
    const log = {
      id: uid(),
      name: wot.label,
      headers: wot.headers,
      rows: wot.rows,
      timeCol: 0,
      rpmCol: 1,
      pedalCol: 2,
      speedCol: (() => {
        const byName = wot.headers.findIndex((h) => scoreHeader(h, SPEED_KEYS) >= 40);
        if (byName >= 0) return byName;
        if (wot.meta?.hasSpeed && wot.headers.length >= 4) return 3;
        if (wot.rows?.some((r) => r.length >= 4 && Number.isFinite(r[3]))) return 3;
        return -1;
      })(),
      pulls: [],
      colorBase: COLORS[colorIdx % COLORS.length],
      rawName: fileName,
      sm2meta: wot.meta,
      sm2Session: session,
    };
    const pull = makePullFromAll(log);
    pull.name = wot.label;
    pull.selected = true;
    log.pulls = [pull];
    logs.push(log);
    added++;
  }
  return added;
}

function uid() {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

async function addFiles(fileList) {
  const opts = optsFromUi();
  for (const file of fileList) {
    try {
      const isSm2 = /\.sm2$/i.test(file.name);
      if (isSm2) {
        if (typeof parseSm2ArrayBuffer !== "function") {
          throw new Error("Модуль sm2.js не загружен");
        }
        const buf = await file.arrayBuffer();
        const parsed = parseSm2ArrayBuffer(buf);
        let added = 0;
        for (const session of parsed.sessions) {
          sm2Sources.push({ session, fileName: file.name });
          added += addWotsFromSession(session, file.name, opts);
        }
        if (!added) {
          alert(`В «${file.name}» нет участков разгона в выбранном фильтре. Нужна Δ ≥ ползунка (от 4000 об/мин) и на всей Δ педаль/дроссель в WOT.`);
        }
        continue;
      }

      // CSV Сканматика (экспорт Livedata). Другие логгеры не разбираем.
      if (!/\.csv$/i.test(file.name)) {
        alert(`«${file.name}» — нужен лог Scanmatik .sm2 (или CSV Сканматика).`);
        continue;
      }
      const text = await decodeFile(file);
      const parsed = parseCsvText(text);
      const cols = pickColumns(parsed.headers);
      if (!looksLikeScanmatikCsv(parsed.headers) || cols.rpmCol < 0 || cols.pedalCol < 0) {
        alert(`«${file.name}» не похож на CSV Сканматика (нужны обороты и педаль/дроссель).`);
        continue;
      }
      if (cols.timeCol < 0) cols.timeCol = 0;
      const log = {
        id: uid(),
        name: file.name.replace(/\.(sm2|csv)$/i, ""),
        headers: parsed.headers,
        rows: parsed.rows,
        timeCol: cols.timeCol,
        rpmCol: cols.rpmCol,
        pedalCol: cols.pedalCol,
        speedCol: cols.speedCol,
        pulls: [],
        colorBase: COLORS[colorIdx % COLORS.length],
        rawName: file.name,
        sm2meta: null,
      };
      log.pulls = findPulls(log, opts);
      if (!log.pulls.length) {
        alert(`В «${file.name}» нет WOT-разгона (на всей Δ педаль/дроссель в WOT, набор ≥ Δ от 4000 об/мин).`);
      }
      logs.push(log);
    } catch (e) {
      console.error(e);
      alert(`Ошибка чтения «${file.name}»: ${e.message || e}`);
    }
  }
  selectDefaultPulls();
  renderColumnMap();
  renderPullList();
  renderCharts();
  renderStats();
}

function selectDefaultPulls() {
  const countByFile = new Map();
  for (const log of logs) {
    const key = log.rawName || log.id;
    for (const p of log.pulls) {
      const n = countByFile.get(key) || 0;
      p.selected = n < 3;
      countByFile.set(key, n + 1);
    }
  }
}

function makePullFromAll(log) {
  const opts = optsFromUi();
  const { time, rpm, pedal, speed } = getSeries(log);
  const dtWin = opts.dtWindow ?? 0.2;
  const win = Math.max(1, opts.smoothWindow | 0);
  const rpmAccel = computeAccelSeries(time, rpm, { dtWindow: dtWin, smoothWindow: win }, "classic");
  const rpmAccelLink = computeAccelSeries(time, rpm, { dtWindow: dtWin, smoothWindow: win }, "link");
  let vehAccelClassic = null;
  let vehAccelLink = null;
  if (speed) {
    const v = speed.map((s) => (Number.isFinite(s) ? s / 3.6 : NaN));
    vehAccelClassic = computeAccelSeries(time, v, { dtWindow: dtWin, smoothWindow: win }, "classic");
    vehAccelLink = computeAccelSeries(time, v, { dtWindow: dtWin, smoothWindow: win }, "link");
  }
  const points = [];
  for (let k = 0; k < time.length; k++) {
    if (k > 0 && rpm[k] + ((typeof SM2_OBD_DIP === "number") ? SM2_OBD_DIP : 80) < rpm[k - 1]) continue;
    if (!Number.isFinite(rpm[k])) continue;
    points.push({
      t: time[k] - time[0],
      rpm: rpm[k],
      pedal: pedal[k],
      speed: speed ? speed[k] : null,
      rpmAccel: rpmAccel[k],
      rpmAccelLink: rpmAccelLink[k],
      vehAccel: vehAccelClassic ? vehAccelClassic[k] : null,
      vehAccelLink: vehAccelLink ? vehAccelLink[k] : null,
    });
  }
  sanitizePointsSpeed(points);
  const dyno = attachDynoIndex(points, { dtWindow: dtWin, smoothWindow: win });
  const lock = applySpeedGearLock(points, opts);
  return {
    id: `${log.id}-p1`,
    logId: log.id,
    name: log.name,
    start: 0,
    end: time.length - 1,
    t0: time[0],
    t1: time[time.length - 1],
    rpm0: rpm[0],
    rpm1: rpm[rpm.length - 1],
    selected: true,
    color: COLORS[colorIdx++ % COLORS.length],
    points,
    metrics: computeMetrics(points, "classic"),
    metricsLink: computeMetrics(points, "link"),
    metricsDyno: dyno.metricsDyno,
    dynoSource: dyno.source,
    dynoUnit: dyno.unit,
    gearKv: Number.isFinite(lock.gearKv) ? lock.gearKv : dyno.gearKv,
    speedLock: lock,
    overview: {
      time: time.slice(),
      rpm: rpm.slice(),
      pedal: pedal.slice(),
      speed: speed ? speed.slice() : null,
      tOffset: time[0],
    },
  };
}

function reanalyzeAll() {
  const opts = optsFromUi();
  colorIdx = 0;
  const csvLogs = logs.filter((log) => !log.sm2Session);
  logs = [];
  for (const item of sm2Sources) addWotsFromSession(item.session, item.fileName, opts);
  for (const log of csvLogs) {
    log.pulls = findPulls(log, opts);
    log.pulls.forEach((p, i) => { p.selected = i < 3; });
    logs.push(log);
  }
  selectDefaultPulls();
  renderPullList();
  renderCharts();
  renderStats();
  renderColumnMap();
}

function allPulls() {
  return logs.flatMap((l) => l.pulls);
}

function selectedPulls() {
  return allPulls().filter((p) => p.selected);
}

function renderPullList() {
  const box = $("pullList");
  const pulls = allPulls();
  if (!pulls.length) {
    box.className = "pull-list empty";
      box.textContent = (logs.length || sm2Sources.length)
      ? "Разгоны не найдены. Нужна Δ оборотов ≥ ползунка (от 4000) и на всей Δ педаль/дроссель в WOT и статичны (шум до 2%)."
      : "Загрузите .sm2 (OBD-II) — все прогоны подгрузятся сразу.";
    $("exportBtn").disabled = true;
    $("pngBtn").disabled = true;
    return;
  }
  box.className = "pull-list";
  box.innerHTML = "";
  for (const p of pulls) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pull-btn" + (p.selected ? " active" : "");
    btn.style.setProperty("--pull-c", p.color);
    btn.title = p.name;
    btn.innerHTML = `
      <span class="pull-name">${escapeHtml(p.name)}</span>
      <span class="pull-rpm">${Math.round(p.rpm0)}–${Math.round(p.rpm1)}</span>
    `;
    btn.addEventListener("click", () => {
      p.selected = !p.selected;
      btn.classList.toggle("active", p.selected);
      renderCharts();
      renderStats();
      $("exportBtn").disabled = selectedPulls().length !== 1;
      $("pngBtn").disabled = selectedPulls().length === 0;
    });
    box.appendChild(btn);
  }
  $("exportBtn").disabled = selectedPulls().length !== 1;
  $("pngBtn").disabled = selectedPulls().length === 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmt(n, digits = 1) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function fmtSec(n) {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)} с`;
}

function renderColumnMap() {
  const panel = $("columnMapPanel");
  const map = $("columnMap");
  if (!logs.length) { panel.hidden = true; return; }
  panel.hidden = false;
  const log = logs[logs.length - 1];
  const mkSelect = (id, selected) => {
    const opts = log.headers.map((h, i) =>
      `<option value="${i}" ${i === selected ? "selected" : ""}>${escapeHtml(h || `(кол.${i})`)}</option>`
    ).join("");
    return `<select id="${id}">${opts}<option value="-1" ${selected < 0 ? "selected" : ""}>— нет —</option></select>`;
  };
  map.innerHTML = `
    <label>Файл (последний)
      <div style="color:var(--text);padding:8px 0">${escapeHtml(log.name)}</div>
    </label>
    <label>Время ${mkSelect("mapTime", log.timeCol)}</label>
    <label>Обороты ${mkSelect("mapRpm", log.rpmCol)}</label>
    <label>Педаль ${mkSelect("mapPedal", log.pedalCol)}</label>
    <label>Скорость ${mkSelect("mapSpeed", log.speedCol)}</label>
    <div class="actions"><button type="button" class="btn" id="applyColsBtn">Применить к последнему файлу</button></div>
  `;
  $("applyColsBtn").onclick = () => {
    log.timeCol = Number($("mapTime").value);
    log.rpmCol = Number($("mapRpm").value);
    log.pedalCol = Number($("mapPedal").value);
    log.speedCol = Number($("mapSpeed").value);
    const opts = optsFromUi();
    log.pulls = findPulls(log, opts);
    renderPullList();
    renderCharts();
    renderStats();
  };
  const meta = log.sm2meta;
  $("columnHint").textContent =
    (meta
      ? `SM2 OBD-II «${log.name}»: каналов=${meta.channelCount}, кадров=${meta.samples}` +
        (meta.duration ? `, длит. ${meta.duration.toFixed(2)} с` : "") +
        (meta.maxPedal != null ? `, max газ ${meta.maxPedal.toFixed(0)}% (порог ${meta.fullThr?.toFixed?.(0) ?? "—"}%)` : "") +
        ". "
      : "") +
    `Колонки: время=«${log.headers[log.timeCol]}», обороты=«${log.headers[log.rpmCol]}», педаль/дроссель=«${log.headers[log.pedalCol]}»` +
    (log.speedCol >= 0 ? `, скорость=«${log.headers[log.speedCol]}» (подхвачена автоматически)` : ", скорость не найдена") +
    `. Разгон: на всей Δ педаль/дроссель в WOT ≥ ${optsFromUi().wotFloor}% и статичны (шум до 2%), набор ≥ ${optsFromUi().minRpmGain} об/мин` +
    (optsFromUi().speedLock
      ? ". Уточнение по скорости: вкл. (жёсткая передача). На АКПП снимите галочку."
      : ". Уточнение по скорости выкл.");
}

function metricValue(p, metric, mode = "classic") {
  if (metric === "vehicle_accel") {
    return mode === "link" ? p.vehAccelLink : p.vehAccel;
  }
  return mode === "link" ? p.rpmAccelLink : p.rpmAccel;
}

/** Ось оборотов (X): фиксированный диапазон 2000–7500, шаг 250. */
function rpmAxisOpts(title = "Обороты, об/мин") {
  return {
    type: "linear",
    min: 2000,
    max: 7500,
    title: { display: true, text: title, color: "#9aa6b5" },
    ticks: {
      color: "#9aa6b5",
      stepSize: 250,
      autoSkip: false,
      maxTicksLimit: 40,
      callback: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return "";
        return Math.abs(n % 250) < 0.5 || Math.abs(n % 250 - 250) < 0.5 ? Math.round(n) : undefined;
      },
    },
    grid: { color: "#243041" },
  };
}

/** Ось оборотов (Y, обзор): авто по данным, шаг подписей 250. */
function rpmYAxisOpts(min, max) {
  const opts = {
    position: "left",
    grace: "6%",
    title: { display: true, text: "об/мин", color: "#9aa6b5" },
    ticks: {
      color: "#9aa6b5",
      stepSize: 250,
      callback: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return "";
        return Math.abs(n % 250) < 0.5 || Math.abs(n % 250 - 250) < 0.5 ? Math.round(n) : undefined;
      },
    },
    grid: { color: "#243041" },
  };
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
    opts.min = min;
    opts.max = max;
    delete opts.grace;
  }
  return opts;
}

const RPM_AXIS_MIN = 2000;
const RPM_AXIS_MAX = 7500;
const RPM_AXIS_STEP = 250;

function syncDeltaSliderExtent() {
  const sl = $("deltaRpm");
  if (!sl) return;
  sl.min = String(RPM_AXIS_MIN);
  sl.max = String(RPM_AXIS_MAX);
  sl.step = String(RPM_AXIS_STEP);
  let v = Number(sl.value);
  if (!Number.isFinite(v) || v < RPM_AXIS_MIN || v > RPM_AXIS_MAX) {
    v = 3500;
  }
  sl.value = String(v);
  const lab = $("deltaRpmLabel");
  if (lab) lab.textContent = `${v}`;
}

/** Линейная интерполяция y по x в серии {x,y}[]. */
function interpSeriesY(data, x) {
  if (!data?.length || !Number.isFinite(x)) return NaN;
  const pts = data
    .map((p) => ({ x: p.x ?? p?.parsed?.x, y: p.y ?? p?.parsed?.y }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2) return Number.isFinite(pts[0]?.y) ? pts[0].y : NaN;
  if (x < pts[0].x || x > pts[pts.length - 1].x) return NaN;
  let i = 0;
  while (i + 1 < pts.length && pts[i + 1].x < x) i++;
  const a = pts[i];
  const b = pts[Math.min(i + 1, pts.length - 1)];
  if (b.x <= a.x) return a.y;
  const u = (x - a.x) / (b.x - a.x);
  return a.y + u * (b.y - a.y);
}

function deltaPct(y, yBase) {
  if (!(yBase > 0) || !Number.isFinite(y)) return NaN;
  return 100 * (y - yBase) / yBase;
}

function fmtDeltaPct(pct) {
  if (!Number.isFinite(pct)) return "—";
  const s = pct >= 0 ? "+" : "";
  return `${s}${pct.toFixed(1)}%`;
}

/** Вертикальный ползунок-курсор по оборотам + подписи Δ%. */
const rpmCursorPlugin = {
  id: "rpmCursor",
  afterDraw(chart) {
    const rpm = chart.$cursorRpm;
    if (!Number.isFinite(rpm)) return;
    const xScale = chart.scales.x;
    if (!xScale || xScale.id !== "x") return;
    if (xScale.min > 1000) {
      // ось оборотов
    } else {
      return; // обзор по времени — не рисуем
    }
    const x = xScale.getPixelForValue(rpm);
    const { top, bottom } = chart.chartArea;
    if (x < chart.chartArea.left || x > chart.chartArea.right) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = "rgba(224, 168, 74, 0.85)";
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  },
};

function valuesAtRpmFromChart(chart, rpm) {
  if (!chart?.data?.datasets) return [];
  return chart.data.datasets.map((ds) => ({
    label: ds.label,
    color: ds.borderColor,
    y: interpSeriesY(ds.data, rpm),
  })).filter((v) => Number.isFinite(v.y));
}

/** Две лучшие (максимальные) кривые в данной точке оборотов. */
function topTwoAtRpm(chart, rpm) {
  const vals = valuesAtRpmFromChart(chart, rpm)
    .slice()
    .sort((a, b) => b.y - a.y);
  if (vals.length < 2) return null;
  return { best: vals[0], second: vals[1] };
}

function deltaChipHtml(best, second) {
  const pct = deltaPct(best.y, second.y);
  const cls = Number.isFinite(pct) && pct >= 0 ? "up" : "down";
  return `<div class="delta-chip">
    <span class="swatch" style="background:${best.color}"></span>
    <span class="delta-sep">−</span>
    <span class="swatch" style="background:${second.color}"></span>
    <span class="delta-pct ${cls}">${fmtDeltaPct(pct)}</span>
  </div>`;
}

function activeMainChart() {
  if (accelTab === "dyno") return accelChartDyno;
  if (accelTab === "classic") return accelChartClassic;
  return accelChartLink;
}

function setChartsCursorRpm(rpm, syncSlider = true) {
  const r = Math.round(Number(rpm) / RPM_AXIS_STEP) * RPM_AXIS_STEP;
  const clamped = Math.max(RPM_AXIS_MIN, Math.min(RPM_AXIS_MAX, r));
  for (const ch of [accelChartClassic, accelChartLink, accelChartDyno]) {
    if (!ch) continue;
    const changed = ch.$cursorRpm !== clamped;
    ch.$cursorRpm = clamped;
    if (changed) ch.draw();
  }
  if (syncSlider) {
    const sl = $("deltaRpm");
    if (sl && Number(sl.value) !== clamped) sl.value = String(clamped);
  }
  const lab = $("deltaRpmLabel");
  if (lab) lab.textContent = `${clamped}`;
  updateDeltaReadout(clamped);
}

function updateDeltaReadout(rpm) {
  const box = $("deltaReadout");
  if (!box) return;
  const pair = topTwoAtRpm(activeMainChart(), rpm);
  if (!pair) {
    box.className = "delta-readout muted";
    box.innerHTML = `<span class="muted">—</span>`;
    return;
  }
  box.className = "delta-readout";
  box.innerHTML = deltaChipHtml(pair.best, pair.second);
}

function getOrCreateDeltaTip() {
  let el = document.getElementById("chartDeltaTip");
  if (!el) {
    el = document.createElement("div");
    el.id = "chartDeltaTip";
    el.className = "chart-delta-tip";
    document.body.appendChild(el);
  }
  return el;
}

/** Подсказка: Δ% только между двумя верхними кривыми в этой точке об/мин. */
function externalDeltaTooltip(context) {
  const { chart, tooltip } = context;
  const tip = getOrCreateDeltaTip();
  if (!tooltip || tooltip.opacity === 0) {
    tip.style.opacity = "0";
    tip.style.pointerEvents = "none";
    return;
  }
  const rpm = tooltip.dataPoints?.[0]?.parsed?.x;
  const pair = topTwoAtRpm(chart, rpm);
  if (!pair) {
    tip.style.opacity = "0";
    return;
  }
  tip.innerHTML = deltaChipHtml(pair.best, pair.second);

  const canvas = chart.canvas;
  const rect = canvas.getBoundingClientRect();
  tip.style.opacity = "1";
  tip.style.left = `${rect.left + window.scrollX + tooltip.caretX + 14}px`;
  tip.style.top = `${rect.top + window.scrollY + tooltip.caretY - 12}px`;

  if (!canvas.$deltaLeaveBound) {
    canvas.$deltaLeaveBound = true;
    canvas.addEventListener("mouseleave", () => {
      tip.style.opacity = "0";
    });
  }
}

function deltaTooltipOpts() {
  return {
    enabled: false,
    external: externalDeltaTooltip,
    mode: "nearest",
    axis: "x",
    intersect: false,
  };
}

function buildAccelDatasets(selected, opts, mode) {
  // classic = V1 OK: точки в порядке времени, без «полки» по корзинам
  if (mode === "classic") {
    return selected.map((pull) => {
      const pts = pull.points
        .filter((p) => {
          const y = metricValue(p, opts.metric, "classic");
          return Number.isFinite(p.rpm) && Number.isFinite(y) && y > 40;
        })
        .map((p) => ({ x: p.rpm, y: metricValue(p, opts.metric, "classic") }));
      return {
        label: pull.name,
        data: pts,
        showLine: true,
        borderColor: pull.color,
        backgroundColor: pull.color,
        pointRadius: 0,
        borderWidth: 1.35,
        tension: 0.22,
        spanGaps: false,
        order: 1,
      };
    }).filter((d) => d.data.length >= 2);
  }

  const warm = 0.15;
  const datasets = [];
  for (const pull of selected) {
    let pts = trimPullTransient(pull.points, warm);
    if (pts.length < 3) pts = pull.points;
    let raw = pts
      .map((p) => ({ x: p.rpm, y: metricValue(p, opts.metric, mode) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.y > 0);
    if (raw.length < 3) {
      raw = pts
        .map((p) => ({ x: p.rpm, y: metricValue(p, opts.metric, "classic") }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.y > 0);
    }
    if (raw.length < 2) continue;

    let shelf = shelfCurveVsRpm(raw, 200, { minY: 30, iqrFloor: 80 });
    if (!shelf || shelf.length < 2) {
      shelf = raw.slice().sort((a, b) => a.x - b.x);
    }
    datasets.push({
      label: pull.name,
      data: shelf,
      showLine: true,
      borderColor: pull.color,
      backgroundColor: pull.color,
      pointRadius: 0,
      borderWidth: 1.5,
      tension: 0.28,
      spanGaps: false,
      order: 1,
    });
  }
  return datasets;
}

function makeAccelChart(canvas, datasets, opts, mode) {
  const dtWin = opts.dtWindow || 0.2;
  const linkScale = 1 / dtWin;
  const yTitle = opts.metric === "vehicle_accel"
    ? (mode === "link" ? "м/с² · моментная полка (Link)" : "м/с² · dV/dt")
    : (mode === "link"
      ? `об/мин/с · полка момента (Link dt×${linkScale.toFixed(0)})`
      : "об/мин/с · ускорение оборотов dRPM/dt");
  const tip = deltaTooltipOpts();
  return new Chart(canvas.getContext("2d"), {
    type: "scatter",
    data: { datasets },
    plugins: [rpmCursorPlugin],
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      onHover: (evt, _els, chart) => {
        const xScale = chart.scales.x;
        if (!xScale || evt.x == null) return;
        const rpm = xScale.getValueForPixel(evt.x);
        if (Number.isFinite(rpm) && rpm >= RPM_AXIS_MIN && rpm <= RPM_AXIS_MAX) {
          setChartsCursorRpm(rpm, true);
        }
      },
      scales: {
        x: rpmAxisOpts("Обороты, об/мин"),
        y: {
          type: "linear",
          beginAtZero: true,
          grace: "8%",
          title: { display: true, text: yTitle, color: "#9aa6b5" },
          ticks: { color: "#9aa6b5" },
          grid: { color: "#243041" },
        },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#e8edf4",
            boxWidth: 12,
            boxHeight: 2,
            padding: 10,
            font: { size: 11 },
          },
        },
        tooltip: tip,
      },
    },
  });
}

function alignRefRpm(selected) {
  const starts = selected.map((p) => {
    const r0 = p.overview?.rpm?.[0];
    return Number.isFinite(r0) ? r0 : (Number.isFinite(p.rpm0) ? p.rpm0 : NaN);
  }).filter((v) => Number.isFinite(v));
  const ends = selected.map((p) => {
    const rpm = p.overview?.rpm;
    const r1 = rpm?.length ? rpm[rpm.length - 1] : p.rpm1;
    return Number.isFinite(r1) ? r1 : NaN;
  }).filter((v) => Number.isFinite(v));
  if (!starts.length) return 2000;
  if (starts.length >= 2 && ends.length >= 2) {
    const overlapLo = Math.max(...starts);
    const overlapHi = Math.min(...ends);
    if (overlapHi - overlapLo >= 80) return overlapLo;
  }
  return Math.min(...starts);
}

function timeAtRpm(ov, targetRpm) {
  const { time, rpm } = ov;
  if (!time?.length) return null;
  if (rpm[0] >= targetRpm) return time[0];
  for (let i = 1; i < rpm.length; i++) {
    if (rpm[i] < targetRpm) continue;
    const r0 = rpm[i - 1];
    const r1 = rpm[i];
    if (r1 <= r0) return time[i];
    const u = (targetRpm - r0) / (r1 - r0);
    return time[i - 1] + u * (time[i] - time[i - 1]);
  }
  return null;
}

function buildAlignedSeries(selected, refRpm, opts = {}) {
  const wantSpeed = !!opts.speedLock && selected.every(pullHasUsableSpeed);
  let refSpeed = NaN;
  if (wantSpeed) {
    const starts = selected.map((p) => {
      const s0 = p.overview.speed.find((v) => Number.isFinite(v) && v > 0);
      return Number.isFinite(s0) ? s0 : NaN;
    }).filter((v) => Number.isFinite(v));
    if (starts.length) refSpeed = Math.max(...starts);
  }
  const useSpeed = wantSpeed && Number.isFinite(refSpeed) && refSpeed > 3;

  const series = [];
  for (const pull of selected) {
    const ov = pull.overview;
    if (!ov || !ov.time || !ov.time.length) continue;
    const tSync = useSpeed
      ? (timeAtValue(ov.time, ov.speed, refSpeed) ?? timeAtRpm(ov, refRpm))
      : timeAtRpm(ov, refRpm);
    if (tSync == null) continue;
    const rpmPts = [];
    const pedPts = [];
    const spdPts = [];
    for (let i = 0; i < ov.time.length; i++) {
      if (!useSpeed && ov.rpm[i] + 15 < refRpm && ov.time[i] < tSync) continue;
      if (useSpeed && Number.isFinite(ov.speed?.[i]) && ov.speed[i] + 1 < refSpeed && ov.time[i] < tSync) continue;
      const x = +(ov.time[i] - tSync).toFixed(3);
      if (x < -0.05) continue;
      rpmPts.push({ x, y: ov.rpm[i] });
      pedPts.push({ x, y: ov.pedal[i] });
      if (ov.speed) spdPts.push({ x, y: ov.speed[i] });
    }
    if (rpmPts.length < 2) continue;
    series.push({ pull, rpmPts, pedPts, spdPts, useSpeed, refSpeed });
  }
  return { series, useSpeed, refSpeed };
}

function setAccelTab(tab) {
  accelTab = tab === "dyno" ? "dyno" : (tab === "classic" ? "classic" : "link");
  document.querySelectorAll(".tab[data-accel-tab]").forEach((btn) => {
    const on = btn.getAttribute("data-accel-tab") === accelTab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("[data-accel-panel]").forEach((panel) => {
    const on = panel.getAttribute("data-accel-panel") === accelTab;
    panel.classList.toggle("active", on);
    panel.hidden = !on;
  });
  renderPullList();
  renderStats();
  renderCharts();
}

function buildDynoDatasets(selected) {
  const shelves = [];
  for (const pull of selected) {
    let pts = trimPullTransient(pull.points, 0.2);
    if (pts.length < 3) pts = pull.points;
    const raw = pts
      .map((p) => ({ x: p.rpm, y: p.pSpec }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.y > 0.02);
    if (raw.length < 2) continue;
    let shelf = shelfCurveVsRpm(raw, 150, { minY: 0.02, iqrFloor: 0.25, smoothHalf: 3 });
    if (!shelf || shelf.length < 2) shelf = raw.slice().sort((a, b) => a.x - b.x);
    shelves.push({ pull, shelf, source: pull.dynoSource || "rpm", unit: pull.dynoUnit || "отн." });
  }

  const datasets = shelves.map(({ pull, shelf }, i) => ({
    label: pull.name,
    data: shelf,
    yAxisID: "y",
    showLine: true,
    borderColor: pull.color,
    backgroundColor: pull.color,
    pointRadius: 0,
    borderWidth: 1.5,
    tension: 0.22,
    spanGaps: false,
    order: i + 1,
  }));

  return {
    datasets,
    unit: shelves[0]?.unit || "отн.",
    source: shelves[0]?.source || "rpm",
  };
}

function makeDynoChart(canvas, pack) {
  const unitLabel = pack.unit === "Вт/кг"
    ? "отн. мощность P/m = a·v, Вт/кг"
    : "отн. мощность P/m ∝ (dRPM/dt)·RPM";
  const srcHint = pack.source === "speed" ? "VSS"
    : pack.source === "speed+gear" ? "VSS+передача"
    : "только RPM";
  const tip = deltaTooltipOpts();
  return new Chart(canvas.getContext("2d"), {
    type: "scatter",
    data: { datasets: pack.datasets },
    plugins: [rpmCursorPlugin],
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 4, right: 8 } },
      interaction: { mode: "nearest", axis: "x", intersect: false },
      onHover: (evt, _els, chart) => {
        const xScale = chart.scales.x;
        if (!xScale || evt.x == null) return;
        const rpm = xScale.getValueForPixel(evt.x);
        if (Number.isFinite(rpm) && rpm >= RPM_AXIS_MIN && rpm <= RPM_AXIS_MAX) {
          setChartsCursorRpm(rpm, true);
        }
      },
      scales: {
        x: rpmAxisOpts("Обороты, об/мин"),
        y: {
          type: "linear",
          position: "left",
          beginAtZero: true,
          grace: "8%",
          title: { display: true, text: `${unitLabel} · ${srcHint}`, color: "#9aa6b5" },
          ticks: { color: "#9aa6b5" },
          grid: { color: "#243041" },
        },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#e8edf4",
            boxWidth: 12,
            boxHeight: 2,
            padding: 10,
            font: { size: 11 },
          },
        },
        tooltip: tip,
      },
    },
  });
}

function sampleRateFromTimes(time) {
  if (!time || time.length < 2) return null;
  const dts = [];
  for (let i = 1; i < time.length; i++) {
    const dt = time[i] - time[i - 1];
    if (Number.isFinite(dt) && dt > 1e-4 && dt < 2.5) dts.push(dt);
  }
  if (!dts.length) return null;
  dts.sort((a, b) => a - b);
  const med = dts[Math.floor(dts.length / 2)];
  if (!(med > 0)) return null;
  return { dt: med, hz: 1 / med, n: time.length };
}

function fmtHz(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return "—";
  if (hz >= 20) return hz.toFixed(0);
  if (hz >= 10) return hz.toFixed(1);
  return hz.toFixed(1);
}

function fmtSampleRate(info) {
  if (!info) return "";
  return `${fmtHz(info.hz)} Гц · шаг ${info.dt.toFixed(2)} с · ${info.n} т.`;
}

/** Подпись частоты фиксации оборотов в углу обзора. */
const overviewRatePlugin = {
  id: "overviewRate",
  afterDraw(chart) {
    const lines = chart.options?.plugins?.overviewRate?.lines || chart.$rateLines;
    if (!lines?.length) return;
    const { ctx, chartArea } = chart;
    if (!chartArea) return;
    ctx.save();
    ctx.font = "600 11px Segoe UI, Tahoma, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let y = chartArea.top + 4;
    const x = chartArea.left + 8;
    for (const line of lines) {
      const text = line.text;
      const w = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(18, 21, 26, 0.72)";
      ctx.fillRect(x - 4, y - 2, w + 8, 16);
      ctx.fillStyle = line.color || "#c5d0dc";
      ctx.fillText(text, x, y);
      y += 16;
    }
    ctx.restore();
  },
};

function renderCharts() {
  const opts = optsFromUi();
  const selected = selectedPulls();
  const overCtx = $("overviewChart").getContext("2d");

  if (accelChartClassic) { accelChartClassic.destroy(); accelChartClassic = null; }
  if (accelChartLink) { accelChartLink.destroy(); accelChartLink = null; }
  if (accelChartDyno) { accelChartDyno.destroy(); accelChartDyno = null; }

  const classicCanvas = $("accelChartClassic");
  const linkCanvas = $("accelChartLink");
  const dynoCanvas = $("accelChartDyno");
  const classicPanel = document.querySelector('[data-accel-panel="classic"]');
  const linkPanel = document.querySelector('[data-accel-panel="link"]');
  const dynoPanel = document.querySelector('[data-accel-panel="dyno"]');

  const buildOne = (mode, canvas, panel) => {
    if (!canvas) return null;
    const hideAfter = panel && panel.hidden;
    if (hideAfter) panel.hidden = false;
    let chart;
    if (mode === "dyno") {
      chart = makeDynoChart(canvas, buildDynoDatasets(selected));
    } else {
      chart = makeAccelChart(canvas, buildAccelDatasets(selected, opts, mode), opts, mode);
    }
    if (hideAfter) panel.hidden = true;
    return chart;
  };

  const order = accelTab === "dyno" ? ["dyno", "link", "classic"]
    : accelTab === "classic" ? ["classic", "link", "dyno"]
      : ["link", "classic", "dyno"];
  for (const mode of order) {
    if (mode === "classic") accelChartClassic = buildOne("classic", classicCanvas, classicPanel);
    else if (mode === "link") accelChartLink = buildOne("link", linkCanvas, linkPanel);
    else accelChartDyno = buildOne("dyno", dynoCanvas, dynoPanel);
  }
  requestAnimationFrame(() => {
    if (accelTab === "classic" && accelChartClassic) accelChartClassic.resize();
    if (accelTab === "link" && accelChartLink) accelChartLink.resize();
    if (accelTab === "dyno" && accelChartDyno) accelChartDyno.resize();
  });

  if (overviewChart) overviewChart.destroy();
  if (!selected.length) {
    overviewChart = new Chart(overCtx, { type: "line", data: { datasets: [] }, options: { responsive: true, maintainAspectRatio: false } });
    $("overviewHint").textContent = "выберите разгон";
    $("compareHint").textContent = "Выберите 1+ разгон слева для сравнения";
    const box = $("deltaReadout");
    if (box) {
      box.className = "delta-readout muted";
      box.textContent = "Выберите 2+ прогона для сравнения Δ%.";
    }
    return;
  }

  const refRpm = alignRefRpm(selected);
  const alignedPack = buildAlignedSeries(selected, refRpm, opts);
  const aligned = alignedPack.series || [];
  const overDatasets = [];
  const showSpeed = aligned.some((s) => s.spdPts?.some((p) => Number.isFinite(p.y) && p.y > 0));
  const showPedal = aligned.some((s) => s.pedPts?.some((p) => Number.isFinite(p.y)));
  const spdMax = showSpeed
    ? Math.max(80, ...aligned.flatMap((s) => s.spdPts.map((p) => p.y).filter(Number.isFinite)))
    : 110;
  const y1Max = showSpeed ? Math.max(showPedal ? 110 : 0, Math.ceil(spdMax / 10) * 10) : 110;
  const rates = selected.map((p) => ({
    pull: p,
    info: sampleRateFromTimes(p.overview?.time),
  })).filter((x) => x.info);
  const rateLines = [];
  if (rates.length === 1) {
    rateLines.push({
      color: rates[0].pull.color,
      text: `Обороты: ${fmtSampleRate(rates[0].info)}`,
    });
  } else if (rates.length > 1) {
    const hz0 = rates[0].info.hz;
    const same = rates.every((r) => Math.abs(r.info.hz - hz0) / hz0 < 0.12);
    if (same) {
      rateLines.push({
        color: "#c5d0dc",
        text: `Обороты: ${fmtHz(hz0)} Гц · шаг ${rates[0].info.dt.toFixed(2)} с`,
      });
    } else {
      for (const r of rates) {
        rateLines.push({
          color: r.pull.color,
          text: `${r.pull.name}: ${fmtHz(r.info.hz)} Гц · шаг ${r.info.dt.toFixed(2)} с · ${r.info.n} т.`,
        });
      }
    }
  }
  const hzByPull = new Map(rates.map((r) => [r.pull, r.info]));
  for (const { pull, rpmPts, pedPts, spdPts } of aligned) {
    const info = hzByPull.get(pull);
    overDatasets.push({
      label: info ? `${pull.name} · ${fmtHz(info.hz)} Гц` : pull.name,
      data: rpmPts,
      yAxisID: "y",
      borderColor: pull.color,
      backgroundColor: pull.color,
      pointRadius: 0,
      borderWidth: 1.4,
      tension: 0.15,
      fill: false,
      parsing: false,
    });
    if (showPedal && pedPts?.length) {
      overDatasets.push({
        label: `${pull.name} · педаль/дроссель`,
        data: pedPts,
        yAxisID: "y1",
        borderColor: pull.color,
        backgroundColor: "transparent",
        pointRadius: 0,
        borderWidth: 1.2,
        borderDash: [7, 4],
        tension: 0.12,
        fill: false,
        parsing: false,
      });
    }
    const plotSpeed = showSpeed && spdPts?.length && !pullSpeedLooksFrozen(pull);
    if (plotSpeed) {
      overDatasets.push({
        label: `${pull.name} · км/ч`,
        data: spdPts,
        yAxisID: "y1",
        borderColor: pull.color,
        backgroundColor: "transparent",
        pointRadius: 0,
        borderWidth: 1.1,
        borderDash: [2, 3],
        tension: 0.12,
        fill: false,
        spanGaps: true,
        parsing: false,
      });
    }
  }

  const rpmYs = aligned.flatMap((s) => s.rpmPts.map((p) => p.y).filter((v) => Number.isFinite(v)));
  let rpmYMin;
  let rpmYMax;
  if (rpmYs.length) {
    const lo = Math.min(...rpmYs);
    const hi = Math.max(...rpmYs);
    rpmYMin = Math.max(0, Math.floor((lo - 80) / 250) * 250);
    rpmYMax = Math.ceil((hi + 80) / 250) * 250;
    if (rpmYMax - rpmYMin < 500) rpmYMax = rpmYMin + 500;
  }

  overviewChart = new Chart(overCtx, {
    type: "line",
    data: { datasets: overDatasets },
    plugins: [overviewRatePlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false, axis: "x" },
      layout: { padding: { top: 6 } },
      scales: {
        x: {
          type: "linear",
          title: {
            display: true,
            text: alignedPack.useSpeed
              ? `Время от ${Math.round(alignedPack.refSpeed)} км/ч, с`
              : `Время от ${Math.round(refRpm)} об/мин, с`,
            color: "#9aa6b5",
          },
          ticks: {
            color: "#9aa6b5",
            callback: (v) => Number(v).toFixed(1),
          },
          grid: { color: "#243041" },
        },
        y: rpmYAxisOpts(rpmYMin, rpmYMax),
        y1: {
          position: "right",
          display: showPedal || showSpeed,
          min: 0,
          max: y1Max,
          title: {
            display: showPedal || showSpeed,
            text: showSpeed && showPedal
              ? "педаль % · км/ч"
              : (showSpeed ? "скорость, км/ч" : "педаль / дроссель %"),
            color: "#9aa6b5",
          },
          ticks: { color: "#9aa6b5" },
          grid: { drawOnChartArea: false },
        },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#e8edf4",
            boxWidth: 12,
            boxHeight: 2,
            padding: 10,
            font: { size: 11 },
          },
        },
        overviewRate: { lines: rateLines },
      },
    },
  });

  const lockOn = selected.some((p) => p.speedLock?.applied);
  const lockSlip = selected.some((p) => p.speedLock?.usable && p.speedLock?.cv > 0.12);
  const rateHint = rates.length
    ? (rates.length === 1 || rates.every((r) => Math.abs(r.info.hz - rates[0].info.hz) / rates[0].info.hz < 0.12)
      ? `фиксация оборотов ${fmtHz(rates[0].info.hz)} Гц (шаг ${rates[0].info.dt.toFixed(2)} с)`
      : `фиксация оборотов ${fmtHz(Math.min(...rates.map((r) => r.info.hz)))}–${fmtHz(Math.max(...rates.map((r) => r.info.hz)))} Гц`)
    : "";
  $("overviewHint").textContent = selected.length > 1
    ? (alignedPack.useSpeed
      ? `Совмещено по ${Math.round(alignedPack.refSpeed)} км/ч · ${aligned.length} прог.${showPedal ? " · педаль/дроссель пунктиром" : ""}${showSpeed ? " · скорость точками" : ""}${rateHint ? ` · ${rateHint}` : ""}`
      : `Совмещено по ${Math.round(refRpm)} об/мин · ${aligned.length} прог.${showPedal ? " · педаль/дроссель пунктиром" : (showSpeed ? " · скорость точками" : " · только обороты")}${rateHint ? ` · ${rateHint}` : ""}`)
    : ([
      selected[0].name,
      showPedal ? "педаль/дроссель пунктиром" : "",
      showSpeed ? "скорость точками" : "",
      rateHint,
    ].filter(Boolean).join(" · "));
  if (accelTab === "dyno") {
    const src = selected[0]?.dynoSource;
    $("compareHint").textContent = selected.length > 1
      ? `Мощность · отн. P/m · выше кривая = сильнее на этих об/мин`
      : (src === "rpm"
        ? "Мощность без VSS: P/m ∝ (dRPM/dt)·RPM; для Вт/кг нужен канал скорости"
        : "Мощность: P/m = a·v [Вт/кг] — выше = сильнее на этих оборотах");
  } else {
    let hint = selected.length > 1
      ? `Сравнение ${selected.length} прогонов · ${accelTab === "classic" ? "ускорение dRPM/dt" : "полка момента (Link)"}`
      : (accelTab === "classic"
        ? "Ускорение оборотов: сглаживание + dRPM/dt между соседними точками"
        : "Полка момента: Link dt + сглаживание по оборотам");
    if (lockOn) hint += " · уточнено по VSS (жёсткая передача)";
    else if (opts.speedLock && lockSlip) hint += " · VSS есть, k плавает — похоже на проскальзывание ГТ";
    $("compareHint").textContent = hint;
  }
  $("exportBtn").disabled = selected.length !== 1;
  $("pngBtn").disabled = false;

  syncDeltaSliderExtent();
  const sl = $("deltaRpm");
  setChartsCursorRpm(sl ? Number(sl.value) : 3500, false);
}

function renderStats() {
  const selected = selectedPulls();
  const box = $("statsTable");
  if (!selected.length) {
    box.className = "stats-table muted";
    box.textContent = "Нет выбранных разгонов.";
    return;
  }
  const mode = accelTab;
  if (mode === "dyno") {
    const base = selected[0];
    const bestPeak = Math.max(...selected.map((p) => p.metricsDyno?.peak || -Infinity));
    const bestT = Math.min(...selected.map((p) => p.metrics?.t2k5k).filter(Number.isFinite));
    const rows = selected.map((p, idx) => {
      const m = p.metricsDyno || {};
      const peakBest = m.peak === bestPeak;
      const tBest = Number.isFinite(p.metrics?.t2k5k) && p.metrics.t2k5k === bestT;
      let dPeak = "—";
      if (idx > 0 && base.metricsDyno?.peak > 0 && m.peak > 0) {
        const pct = 100 * (m.peak - base.metricsDyno.peak) / base.metricsDyno.peak;
        dPeak = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
      } else if (idx === 0) dPeak = "база";
      return `<tr>
        <td><span class="swatch" style="display:inline-block;width:10px;height:10px;background:${p.color};border-radius:2px;margin-right:6px"></span>${escapeHtml(p.name)}${idx === 0 ? " ★" : ""}</td>
        <td class="${peakBest ? "best" : ""}">${fmt(m.peak, 2)} ${escapeHtml(m.unit || p.dynoUnit || "")}</td>
        <td>${fmt(m.avg, 2)}</td>
        <td>${dPeak}</td>
        <td class="${tBest ? "best" : ""}">${fmtSec(p.metrics?.t2k5k)}</td>
        <td>${escapeHtml(p.dynoSource === "speed" ? "VSS" : p.dynoSource === "speed+gear" ? "VSS+передача" : "только RPM")}</td>
        <td>${Math.round(p.rpm0)}–${Math.round(p.rpm1)}</td>
      </tr>`;
    }).join("");
    box.className = "stats-table";
    box.innerHTML = `<table>
      <thead><tr>
        <th>Разгон</th><th>Пик P/m</th><th>Среднее</th><th>Δ пик к базе</th><th>2→5к</th><th>Источник</th><th>Диапазон</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint" style="margin-top:8px">
      <b>Virtual Dyno:</b> P/m = a·v (Вт/кг) или (dRPM/dt)·RPM. Выше полка на оборотах N → там динамика лучше.
      Одна дорога, одна передача. Δ пика к базе — только в таблице.
    </p>`;
    return;
  }
  const mOf = (p) => (mode === "link" ? p.metricsLink : p.metrics) || p.metrics;
  const bestPeak = Math.max(...selected.map((p) => mOf(p).peak || -Infinity));
  const bestT = Math.min(...selected.map((p) => mOf(p).t2k5k).filter(Number.isFinite));
  const rows = selected.map((p) => {
    const m = mOf(p);
    const peakBest = m.peak === bestPeak;
    const tBest = Number.isFinite(m.t2k5k) && m.t2k5k === bestT;
    return `<tr>
      <td><span class="swatch" style="display:inline-block;width:10px;height:10px;background:${p.color};border-radius:2px;margin-right:6px"></span>${escapeHtml(p.name)}</td>
      <td class="${peakBest ? "best" : ""}">${fmt(m.peak, 0)}</td>
      <td>${fmt(m.avg, 0)}</td>
      <td>${fmt(p.metrics?.peak, 0)} / ${fmt(p.metricsLink?.peak, 0)}</td>
      <td class="${tBest ? "best" : ""}">${fmtSec(m.t2k5k)}</td>
      <td>${fmt(m.duration, 2)} с</td>
      <td>${Math.round(p.rpm0)}–${Math.round(p.rpm1)}</td>
    </tr>`;
  }).join("");
  box.className = "stats-table";
  const modeLabel = mode === "link" ? "момент Link" : "ускорение dRPM/dt";
  box.innerHTML = `<table>
    <thead><tr>
      <th>Разгон</th><th>Пик (${modeLabel})</th><th>Среднее</th><th>Пик Link/dRPM</th><th>2→5к</th><th>Длит.</th><th>Диапазон</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="hint" style="margin-top:8px">Активная вкладка: <b>${modeLabel}</b>. ${mode === "classic" ? "Сырое ускорение оборотов (dRPM/dt)." : "Полка момента (Link)."} Ось об/мин — шаг 250.${
    selected.some((p) => p.speedLock?.applied)
      ? " Уточнение по скорости включено: dRPM/dt смешан с k·dv/dt."
      : (selected.some((p) => p.speedLock?.usable)
        ? " Канал скорости загружен. Галочка «уточнение по скорости» смешает полку с VSS (на АКПП снимите)."
        : "")
  }</p>`;
}

function exportSelectedCsv() {
  const pull = selectedPulls()[0];
  if (!pull) return;
  const headers = ["t_rel_s", "rpm", "pedal_pct", "rpm_accel_time", "rpm_accel_link", "speed", "rpm_eq", "veh_accel_ms2", "p_spec", "f_spec"];
  const lines = [headers.join(";")];
  for (const p of pull.points) {
    lines.push([
      fmt(p.t, 3),
      fmt(p.rpm, 1),
      fmt(p.pedal, 1),
      fmt(p.rpmAccel, 2),
      fmt(p.rpmAccelLink, 2),
      p.speed == null ? "" : fmt(p.speed, 2),
      Number.isFinite(p.rpmEq) ? fmt(p.rpmEq, 1) : "",
      p.vehAccel == null ? "" : fmt(p.vehAccel, 3),
      Number.isFinite(p.pSpec) ? fmt(p.pSpec, 4) : "",
      Number.isFinite(p.fSpec) ? fmt(p.fSpec, 4) : "",
    ].join(";"));
  }
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${pull.name.replace(/[^\wа-яА-Я0-9._-]+/gi, "_")}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function savePng() {
  const chart = accelTab === "dyno" ? accelChartDyno
    : accelTab === "link" ? accelChartLink : accelChartClassic;
  if (!chart) return;
  const a = document.createElement("a");
  a.href = chart.toBase64Image("image/png", 1);
  a.download = `accel_${accelTab}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
  a.click();
}

function clearAll() {
  logs = [];
  sm2Sources = [];
  colorIdx = 0;
  if (accelChartClassic) { accelChartClassic.destroy(); accelChartClassic = null; }
  if (accelChartLink) { accelChartLink.destroy(); accelChartLink = null; }
  if (accelChartDyno) { accelChartDyno.destroy(); accelChartDyno = null; }
  if (overviewChart) { overviewChart.destroy(); overviewChart = null; }
  renderColumnMap();
  renderPullList();
  renderCharts();
  renderStats();
  $("columnHint").textContent = "Разгон: набор ≥ Δ оборотов (ползунок, не меньше 4000). На всей Δ педаль/дроссель в WOT порога «WOT от».";
}

$("fileInput").addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  if (files.length) await addFiles(files);
  e.target.value = "";
});
$("reanalyzeBtn").addEventListener("click", reanalyzeAll);
$("clearBtn").addEventListener("click", clearAll);
$("exportBtn").addEventListener("click", exportSelectedCsv);
$("pngBtn").addEventListener("click", savePng);
$("metric").addEventListener("change", () => { renderCharts(); });
const speedLockEl = $("speedLock");
if (speedLockEl) {
  speedLockEl.addEventListener("change", () => {
    if (logs.length || sm2Sources.length) reanalyzeAll();
    else renderColumnMap();
  });
}

let reanalyzeTimer = 0;
function scheduleReanalyze() {
  if (!logs.length && !sm2Sources.length) return;
  window.clearTimeout(reanalyzeTimer);
  reanalyzeTimer = window.setTimeout(() => reanalyzeAll(), 200);
}

function bindSlider(id, labelId, fmt) {
  const el = $(id);
  const lab = $(labelId);
  if (!el) return;
  const floor = Number(el.min);
  const sync = () => {
    let n = Number(el.value);
    if (id === "minRpmGain" && (!Number.isFinite(n) || n < 4000)) {
      n = 4000;
      el.value = "4000";
    } else if (Number.isFinite(floor) && Number.isFinite(n) && n < floor) {
      n = floor;
      el.value = String(floor);
    }
    if (lab) lab.textContent = fmt(n);
  };
  el.addEventListener("input", () => {
    sync();
    scheduleReanalyze();
  });
  el.addEventListener("change", () => {
    sync();
    if (logs.length || sm2Sources.length) reanalyzeAll();
  });
  sync();
}

bindSlider("wotFloor", "wotFloorLabel", (n) => `${Math.round(n)}%`);
bindSlider("minRpmGain", "minRpmGainLabel", (n) => String(Math.round(n)));
bindSlider("minDuration", "minDurationLabel", (n) => `${n.toFixed(1)} с`);
bindSlider("smoothWindow", "smoothWindowLabel", (n) => String(Math.round(n)));
bindSlider("dtWindow", "dtWindowLabel", (n) => `${n.toFixed(2)} с`);
document.querySelectorAll(".tab[data-accel-tab]").forEach((btn) => {
  btn.addEventListener("click", () => setAccelTab(btn.getAttribute("data-accel-tab")));
});
const deltaRpmEl = $("deltaRpm");
if (deltaRpmEl) {
  deltaRpmEl.addEventListener("input", () => {
    setChartsCursorRpm(Number(deltaRpmEl.value), false);
  });
}

// Drag & drop
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].filter((f) =>
    /\.(sm2|csv)$/i.test(f.name)
  );
  if (files.length) await addFiles(files);
});
