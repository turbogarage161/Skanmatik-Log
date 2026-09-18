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
let overviewChart = null;

/** @type {Array<LogFile>} */
let logs = [];
let colorIdx = 0;
/** @type {"classic" | "link"} */
let accelTab = "classic";

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
 * Значение на t−window берётся линейной интерполяцией между соседними сэмплами.
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

  return { time, rpm, pedal: pedalPct, speed };
}

function findPulls(log, opts) {
  const { time, rpm, pedal, speed } = getSeries(log);
  const full = opts.fullPedal;
  const release = opts.releasePedal;
  const minDur = opts.minDuration;
  const dtWin = opts.dtWindow ?? 0.2;
  const win = Math.max(1, opts.smoothWindow | 0);

  // Адаптивный «полный газ» по этому логу
  const finitePedal = pedal.filter((v) => Number.isFinite(v));
  const maxPedal = finitePedal.length ? Math.max(...finitePedal) : 100;
  const adaptiveFull = Math.max(Math.min(full, 70), maxPedal * 0.88);
  const adaptiveRelease = Math.min(release, adaptiveFull * 0.55);

  // Классика: сглаживание + dRPM/dt между соседними точками
  const rpmSm = movingAverage(rpm, win);
  const rpmAccelClassic = movingAverage(derivative(rpmSm, time), win);
  // Link: dt(Engine Speed, 0.2)*5  →  Δrpm / 0.2
  const rpmAccelLink = linkDtPerSec(rpm, time, dtWin);

  let vehAccelClassic = null;
  let vehAccelLink = null;
  if (speed) {
    const v = speed.map((s) => (Number.isFinite(s) ? s / 3.6 : NaN));
    const vSm = movingAverage(v, win);
    vehAccelClassic = movingAverage(derivative(vSm, time), win);
    vehAccelLink = linkDtPerSec(v, time, dtWin);
  }

  /** @type {Pull[]} */
  const pulls = [];

  const pushSeg = (a, b) => {
    if (b - a < 3) return;
    const dur = time[b] - time[a];
    if (dur < minDur) return;
    const rpmSpan = rpm[b] - rpm[a];
    if (!(rpmSpan >= 200)) return;

    const points = [];
    for (let k = a; k <= b; k++) {
      const prevRpm = k > a ? rpm[k - 1] : rpm[k];
      if (k > a && rpm[k] + 20 < prevRpm) continue;
      const aClassic = rpmAccelClassic[k];
      const aLink = rpmAccelLink[k];
      if (!Number.isFinite(aClassic) && !Number.isFinite(aLink)) continue;
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
    if (points.length < 4) return;

    const metrics = computeMetrics(points, "classic");
    const metricsLink = computeMetrics(points, "link");
    const color = COLORS[colorIdx++ % COLORS.length];
    pulls.push({
      id: `${log.id}-p${pulls.length + 1}`,
      logId: log.id,
      name: log.name || `WOT #${pulls.length + 1}`,
      start: a,
      end: b,
      t0: time[a],
      t1: time[b],
      rpm0: rpm[a],
      rpm1: rpm[b],
      selected: true,
      color,
      points,
      metrics,
      metricsLink,
      overview: {
        time: time.slice(a, b + 1),
        rpm: rpm.slice(a, b + 1),
        pedal: pedal.slice(a, b + 1),
        tOffset: time[a],
      },
    });
  };

  let i = 0;
  while (i < pedal.length) {
    while (i < pedal.length && !(pedal[i] >= adaptiveFull)) i++;
    if (i >= pedal.length) break;
    const start = i;
    while (i < pedal.length && pedal[i] > adaptiveRelease) i++;
    const end = i - 1;
    if (end <= start) continue;

    // режем по падению оборотов (передачи)
    let segStart = start;
    for (let k = start + 1; k <= end; k++) {
      const drop = rpm[k - 1] - rpm[k];
      if (drop > 250 || k === end) {
        const segEnd = drop > 250 ? k - 1 : end;
        // внутри — самый длинный рост
        let bestA = segStart; let bestB = segStart; let a = segStart;
        for (let j = segStart + 1; j <= segEnd; j++) {
          if (rpm[j] + 30 < rpm[j - 1]) {
            if (j - 1 - a > bestB - bestA) { bestA = a; bestB = j - 1; }
            a = j;
          }
        }
        if (segEnd - a > bestB - bestA) { bestA = a; bestB = segEnd; }
        pushSeg(bestA, bestB);
        segStart = k;
      }
    }
  }

  // если несколько — оставить самый длинный по score
  if (pulls.length > 1 && log.sm2meta) {
    pulls.sort((a, b) => (b.t1 - b.t0) * Math.sqrt(Math.max(b.rpm1 - b.rpm0, 1))
      - (a.t1 - a.t0) * Math.sqrt(Math.max(a.rpm1 - a.rpm0, 1)));
    const best = pulls[0];
    best.selected = true;
    return [best];
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
  return {
    fullPedal: Number($("fullPedal").value),
    releasePedal: Number($("releasePedal").value),
    minDuration: Number($("minDuration").value),
    dtWindow: Number($("dtWindow")?.value) || 0.2,
    smoothWindow: Number($("smoothWindow")?.value) || 5,
    metric: $("metric").value,
  };
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
          const wot = sm2SessionToWotRows(session, {
            fullFloor: Math.min(opts.fullPedal, 70),
            fullRatio: 0.88,
            releasePedal: opts.releasePedal,
            minDuration: opts.minDuration,
            minRpmGain: 300,
          });
          if (!wot) continue;
          /** @type {LogFile} */
          const log = {
            id: uid(),
            name: wot.label,
            headers: wot.headers,
            rows: wot.rows,
            timeCol: 0,
            rpmCol: 1,
            pedalCol: 2,
            speedCol: -1,
            pulls: [],
            colorBase: COLORS[colorIdx % COLORS.length],
            rawName: file.name,
            sm2meta: wot.meta,
          };
          // Один прогон = один лог; findPulls на уже вырезанном WOT даст 1 кусок
          log.pulls = findPulls(log, { ...opts, fullPedal: Math.min(opts.fullPedal, 60), minDuration: 0.3 });
          if (!log.pulls.length) {
            // принудительно весь вырезанный кусок
            log.pulls = [makePullFromAll(log)];
          } else {
            log.pulls.forEach((p) => { p.name = wot.label; p.selected = true; });
          }
          logs.push(log);
          added++;
        }
        if (!added) {
          alert(`В «${file.name}» не найден разгон с педалью/дросселем «в пол» (адаптивный порог).`);
        }
        continue;
      }

      // CSV fallback
      const text = await decodeFile(file);
      const parsed = parseCsvText(text);
      const cols = pickColumns(parsed.headers);
      if (cols.rpmCol < 0 || cols.pedalCol < 0) {
        alert(`Не нашёл обороты/педаль в «${file.name}». Нужен .sm2 OBD-II.`);
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
        alert(`В «${file.name}» нет WOT-разгона.`);
      }
      logs.push(log);
    } catch (e) {
      console.error(e);
      alert(`Ошибка чтения «${file.name}»: ${e.message || e}`);
    }
  }
  renderColumnMap();
  renderPullList();
  renderCharts();
  renderStats();
}

function makePullFromAll(log) {
  const opts = optsFromUi();
  const { time, rpm, pedal, speed } = getSeries(log);
  const dtWin = opts.dtWindow ?? 0.2;
  const win = Math.max(1, opts.smoothWindow | 0);
  const rpmSm = movingAverage(rpm, win);
  const rpmAccel = movingAverage(derivative(rpmSm, time), win);
  const rpmAccelLink = linkDtPerSec(rpm, time, dtWin);
  const points = [];
  for (let k = 0; k < time.length; k++) {
    if (k > 0 && rpm[k] + 20 < rpm[k - 1]) continue;
    if (!Number.isFinite(rpmAccel[k]) && !Number.isFinite(rpmAccelLink[k])) continue;
    points.push({
      t: time[k] - time[0],
      rpm: rpm[k],
      pedal: pedal[k],
      speed: speed ? speed[k] : null,
      rpmAccel: rpmAccel[k],
      rpmAccelLink: rpmAccelLink[k],
      vehAccel: null,
      vehAccelLink: null,
    });
  }
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
    overview: {
      time: time.slice(),
      rpm: rpm.slice(),
      pedal: pedal.slice(),
      tOffset: time[0],
    },
  };
}

function reanalyzeAll() {
  const opts = optsFromUi();
  colorIdx = 0;
  for (const log of logs) {
    const selectedIds = new Set(log.pulls.filter((p) => p.selected).map((p) => p.name));
    log.pulls = findPulls(log, opts);
    // keep selection by ordinal if names differ
    log.pulls.forEach((p, i) => { p.selected = i < 3 || selectedIds.has(p.name); });
  }
  renderPullList();
  renderCharts();
  renderStats();
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
      box.textContent = logs.length
      ? "Разгоны не найдены. Уменьшите порог «Полный газ» или мин. длительность."
      : "Загрузите .sm2 (OBD-II) — все прогоны подгрузятся сразу.";
    $("exportBtn").disabled = true;
    $("pngBtn").disabled = true;
    return;
  }
  box.className = "pull-list";
  box.innerHTML = "";
  for (const p of pulls) {
    const card = document.createElement("label");
    card.className = "pull-card" + (p.selected ? " active" : "");
    card.innerHTML = `
      <header>
        <input type="checkbox" ${p.selected ? "checked" : ""} data-id="${p.id}" />
        <span class="swatch" style="background:${p.color}"></span>
        <div>
          <div>${escapeHtml(p.name)}</div>
          <div class="meta">
            ${fmt(p.t0, 1)}–${fmt(p.t1, 1)} с · ${Math.round(p.rpm0)}→${Math.round(p.rpm1)} об/мин<br/>
            пик ${fmt((accelTab === "link" ? p.metricsLink : p.metrics)?.peak, 0)} об/мин/с · Δt 2–5к: ${fmtSec((accelTab === "link" ? p.metricsLink : p.metrics)?.t2k5k)}
            <br/><span class="muted" style="font-size:0.78em">время: ${fmt(p.metrics?.peak, 0)} · Link: ${fmt(p.metricsLink?.peak, 0)}</span>
          </div>
        </div>
      </header>
    `;
    card.querySelector("input").addEventListener("change", (ev) => {
      p.selected = ev.target.checked;
      card.classList.toggle("active", p.selected);
      renderCharts();
      renderStats();
    });
    box.appendChild(card);
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
    (log.speedCol >= 0 ? `, скорость=«${log.headers[log.speedCol]}»` : "");
}

function metricValue(p, metric, mode = "classic") {
  if (metric === "vehicle_accel") {
    return mode === "link" ? p.vehAccelLink : p.vehAccel;
  }
  return mode === "link" ? p.rpmAccelLink : p.rpmAccel;
}

/** Линейная интерполяция метрики по оборотам (для сравнения прогонов). */
function sampleAccelAtRpm(points, rpmTarget, metric, mode) {
  const pts = points
    .map((p) => ({ x: p.rpm, y: metricValue(p, metric, mode) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2) return NaN;
  if (rpmTarget < pts[0].x || rpmTarget > pts[pts.length - 1].x) return NaN;
  let i = 0;
  while (i + 1 < pts.length && pts[i + 1].x < rpmTarget) i++;
  const a = pts[i];
  const b = pts[i + 1] || a;
  if (b.x <= a.x) return a.y;
  const u = (rpmTarget - a.x) / (b.x - a.x);
  return a.y + u * (b.y - a.y);
}

function buildDeltaDataset(pullA, pullB, metric, mode) {
  const lo = Math.max(
    Math.min(...pullA.points.map((p) => p.rpm)),
    Math.min(...pullB.points.map((p) => p.rpm)),
  );
  const hi = Math.min(
    Math.max(...pullA.points.map((p) => p.rpm)),
    Math.max(...pullB.points.map((p) => p.rpm)),
  );
  if (!(hi > lo + 100)) return null;
  const step = Math.max(50, Math.round((hi - lo) / 40));
  const data = [];
  for (let rpm = Math.ceil(lo / 50) * 50; rpm <= hi; rpm += step) {
    const ya = sampleAccelAtRpm(pullA.points, rpm, metric, mode);
    const yb = sampleAccelAtRpm(pullB.points, rpm, metric, mode);
    if (!Number.isFinite(ya) || !Number.isFinite(yb)) continue;
    data.push({ x: rpm, y: ya - yb });
  }
  if (data.length < 3) return null;
  return {
    label: `Δ (${pullA.name} − ${pullB.name})`,
    data,
    showLine: true,
    borderColor: "#e35d5d",
    backgroundColor: "rgba(227,93,93,0.12)",
    pointRadius: 0,
    borderWidth: 1.5,
    borderDash: [5, 4],
    tension: 0.2,
    order: 0,
    yAxisID: "y",
  };
}

function buildAccelDatasets(selected, opts, mode) {
  const yMin = mode === "link" ? 0 : 40;
  const datasets = selected.map((pull) => {
    const pts = pull.points
      .filter((p) => {
        const y = metricValue(p, opts.metric, mode);
        return Number.isFinite(p.rpm) && Number.isFinite(y) && y > yMin;
      })
      .map((p) => ({ x: p.rpm, y: metricValue(p, opts.metric, mode) }));
    return {
      label: pull.name,
      data: pts,
      showLine: true,
      borderColor: pull.color,
      backgroundColor: pull.color,
      pointRadius: 0,
      borderWidth: 2.25,
      tension: 0.2,
      spanGaps: false,
      order: 1,
    };
  });
  if (selected.length >= 2 && opts.metric === "rpm_accel") {
    const delta = buildDeltaDataset(selected[0], selected[1], opts.metric, mode);
    if (delta) datasets.push(delta);
  }
  return datasets;
}

function makeAccelChart(canvas, datasets, opts, mode) {
  const dtWin = opts.dtWindow || 0.2;
  const linkScale = 1 / dtWin;
  const yTitle = opts.metric === "vehicle_accel"
    ? (mode === "link" ? `м/с² · Link dt/${dtWin}с` : "м/с² · по времени")
    : (mode === "link"
      ? `об/мин/с = dt(RPM,${dtWin})×${linkScale.toFixed(0)}`
      : "об/мин/с · dRPM/dt (соседние точки)");
  return new Chart(canvas.getContext("2d"), {
    type: "scatter",
    data: { datasets },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Обороты, об/мин", color: "#9aa6b5" },
          ticks: { color: "#9aa6b5" },
          grid: { color: "#243041" },
        },
        y: {
          type: "linear",
          title: { display: true, text: yTitle, color: "#9aa6b5" },
          ticks: { color: "#9aa6b5" },
          grid: { color: "#243041" },
        },
      },
      plugins: {
        legend: { labels: { color: "#e8edf4" } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const y = ctx.parsed.y;
              const sign = y >= 0 ? "+" : "";
              if (String(ctx.dataset.label || "").startsWith("Δ")) {
                return `${ctx.dataset.label}: ${Math.round(ctx.parsed.x)} → ${sign}${y.toFixed(0)}`;
              }
              return `${ctx.dataset.label}: ${Math.round(ctx.parsed.x)} об/мин → ${y.toFixed(0)}`;
            },
          },
        },
      },
    },
  });
}

function setAccelTab(tab) {
  accelTab = tab === "link" ? "link" : "classic";
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
  requestAnimationFrame(() => {
    if (accelTab === "classic" && accelChartClassic) accelChartClassic.resize();
    if (accelTab === "link" && accelChartLink) accelChartLink.resize();
  });
}

function renderCharts() {
  const opts = optsFromUi();
  const selected = selectedPulls();
  const overCtx = $("overviewChart").getContext("2d");
  const dtWin = opts.dtWindow || 0.2;
  const linkScale = 1 / dtWin;

  if (accelChartClassic) { accelChartClassic.destroy(); accelChartClassic = null; }
  if (accelChartLink) { accelChartLink.destroy(); accelChartLink = null; }

  const classicCanvas = $("accelChartClassic");
  const linkCanvas = $("accelChartLink");
  if (classicCanvas) {
    accelChartClassic = makeAccelChart(classicCanvas, buildAccelDatasets(selected, opts, "classic"), opts, "classic");
  }
  if (linkCanvas) {
    accelChartLink = makeAccelChart(linkCanvas, buildAccelDatasets(selected, opts, "link"), opts, "link");
  }

  if (overviewChart) overviewChart.destroy();
  if (!selected.length) {
    overviewChart = new Chart(overCtx, { type: "line", data: { datasets: [] }, options: { responsive: true, maintainAspectRatio: false } });
    $("overviewHint").textContent = "выберите разгон";
    $("compareHint").textContent = "Выберите 1+ разгон слева для сравнения";
    return;
  }
  const focus = selected[0];
  const ov = focus.overview;
  const rpmPts = ov.time.map((t, i) => ({ x: +(t - ov.tOffset).toFixed(3), y: ov.rpm[i] }));
  const pedPts = ov.time.map((t, i) => ({ x: +(t - ov.tOffset).toFixed(3), y: ov.pedal[i] }));
  overviewChart = new Chart(overCtx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "Обороты",
          data: rpmPts,
          yAxisID: "y",
          borderColor: focus.color,
          pointRadius: 0,
          borderWidth: 2,
          parsing: false,
        },
        {
          label: "Педаль %",
          data: pedPts,
          yAxisID: "y1",
          borderColor: "#e0a84a",
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [4, 3],
          parsing: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false, axis: "x" },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Время участка, с", color: "#9aa6b5" },
          ticks: {
            color: "#9aa6b5",
            callback: (v) => Number(v).toFixed(1),
          },
          grid: { color: "#243041" },
        },
        y: {
          position: "left",
          title: { display: true, text: "об/мин", color: "#9aa6b5" },
          ticks: { color: "#9aa6b5" },
          grid: { color: "#243041" },
        },
        y1: {
          position: "right",
          min: 0,
          max: 110,
          title: { display: true, text: "педаль %", color: "#9aa6b5" },
          ticks: { color: "#9aa6b5" },
          grid: { drawOnChartArea: false },
        },
      },
      plugins: { legend: { labels: { color: "#e8edf4" } } },
    },
  });
  $("overviewHint").textContent = focus.name;
  $("compareHint").textContent = selected.length > 1
    ? `Сравнение ${selected.length} прогонов · вкладки: по времени / Link dt×${linkScale.toFixed(0)}`
    : `Вкладки: по времени (dRPM/dt) и Link dt(RPM,${dtWin})×${linkScale.toFixed(0)}`;
  $("exportBtn").disabled = selected.length !== 1;
  $("pngBtn").disabled = false;
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
  const modeLabel = mode === "link" ? "Link dt×5" : "по времени";
  box.innerHTML = `<table>
    <thead><tr>
      <th>Разгон</th><th>Пик (${modeLabel})</th><th>Среднее</th><th>Пик время/Link</th><th>2→5к</th><th>Длит.</th><th>Диапазон</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="hint" style="margin-top:8px">Активная вкладка: <b>${modeLabel}</b>. «По времени» — dRPM/dt соседних точек; «Link» — dt(Engine Speed, окно)×(1/окно). Красный пунктир — разница двух первых прогонов.</p>`;
}

function exportSelectedCsv() {
  const pull = selectedPulls()[0];
  if (!pull) return;
  const headers = ["t_rel_s", "rpm", "pedal_pct", "rpm_accel_time", "rpm_accel_link", "speed", "veh_accel_ms2"];
  const lines = [headers.join(";")];
  for (const p of pull.points) {
    lines.push([
      fmt(p.t, 3),
      fmt(p.rpm, 1),
      fmt(p.pedal, 1),
      fmt(p.rpmAccel, 2),
      fmt(p.rpmAccelLink, 2),
      p.speed == null ? "" : fmt(p.speed, 2),
      p.vehAccel == null ? "" : fmt(p.vehAccel, 3),
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
  const chart = accelTab === "link" ? accelChartLink : accelChartClassic;
  if (!chart) return;
  const a = document.createElement("a");
  a.href = chart.toBase64Image("image/png", 1);
  a.download = `accel_${accelTab}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
  a.click();
}

function clearAll() {
  logs = [];
  colorIdx = 0;
  if (accelChartClassic) { accelChartClassic.destroy(); accelChartClassic = null; }
  if (accelChartLink) { accelChartLink.destroy(); accelChartLink = null; }
  if (overviewChart) { overviewChart.destroy(); overviewChart = null; }
  renderColumnMap();
  renderPullList();
  renderCharts();
  renderStats();
  $("columnHint").textContent = "Колонки определяются автоматически. При необходимости выберите вручную после загрузки.";
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
["fullPedal", "releasePedal", "minDuration", "dtWindow", "smoothWindow"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("change", () => { if (logs.length) reanalyzeAll(); });
});
document.querySelectorAll(".tab[data-accel-tab]").forEach((btn) => {
  btn.addEventListener("click", () => setAccelTab(btn.getAttribute("data-accel-tab")));
});

// Drag & drop
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].filter((f) =>
    /\.(sm2|csv)$/i.test(f.name)
  );
  if (files.length) await addFiles(files);
});
