/**
 * Парсер Scanmatik SMFS (.sm2) — OBD-II Livedata.
 *
 * Файл может содержать НЕСКОЛЬКО прогонов (TOC), каждый с FILETIME
 * (подписи как в Сканматике: «17.09.2026 14:43»).
 *
 * 2 канала (компакт):
 *   float64 rpm | int32 time_ms | float64 pedal/thr | int32 time2   (24 байта)
 *
 * N>2 каналов:
 *   на канал: float64 value | int64 time_ms | int64 reserved         (24×N)
 */

const SM2_SAMPLE = 24;

function sm2ReadI32(view, off) {
  return view.getInt32(off, true);
}
function sm2ReadU32(view, off) {
  return view.getUint32(off, true);
}
function sm2ReadI64(view, off) {
  if (typeof view.getBigInt64 === "function") {
    return Number(view.getBigInt64(off, true));
  }
  const lo = view.getUint32(off, true);
  const hi = view.getInt32(off + 4, true);
  return hi * 0x100000000 + lo;
}
function sm2ReadF64(view, off) {
  return view.getFloat64(off, true);
}
function sm2Ok(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function sm2FileTimeToDate(ft) {
  // Windows FILETIME → Date (UTC)
  if (!Number.isFinite(ft) || ft < 1e16 || ft > 3e17) return null;
  const ms = ft / 10000 - 11644473600000;
  const d = new Date(ms);
  if (d.getFullYear() < 2000 || d.getFullYear() > 2100) return null;
  return d;
}

function sm2FormatStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sm2NameScore(name, keys) {
  const h = String(name || "").toLowerCase();
  let best = 0;
  for (const k of keys) {
    if (h === k) best = Math.max(best, 100);
    else if (h.includes(k)) best = Math.max(best, 50 + Math.min(30, k.length));
  }
  return best;
}

const SM2_RPM_KEYS = ["оборот", "rpm", "engine speed", "частота вращения", "коленвал"];
const SM2_PEDAL_KEYS = [
  "педаль", "pedal", "accelerator", "акселер", "положение педали", "app", "запрос момента",
];
const SM2_THROTTLE_KEYS = [
  "дроссел", "throttle", "абсолютное положение дросселя", "положение дросселя", "tps",
];

/** TOC: byte@0x10 = count; entries @0x19, 20 bytes each */
function sm2ParseToc(view, u8) {
  const count = u8[0x10] >= 1 && u8[0x10] <= 32 ? u8[0x10] : 1;
  const entries = [];
  let off = 0x19;
  for (let i = 0; i < count; i++) {
    if (off + 20 > u8.length || u8[off] === 0xff) break;
    const unk = sm2ReadU32(view, off);
    const ft = sm2ReadI64(view, off + 4);
    const type = sm2ReadU32(view, off + 12);
    const size = sm2ReadU32(view, off + 16);
    const date = sm2FileTimeToDate(ft);
    if (size > 0 && size < u8.length * 2) {
      entries.push({
        index: i,
        unk,
        type,
        size,
        filetime: ft,
        date,
        label: date ? sm2FormatStamp(date) : `Прогон ${i + 1}`,
      });
    }
    off += 20;
  }
  return entries;
}

/** Начала блоков «Переменные» / сессий */
function sm2FindSessionStarts(u8) {
  const starts = [];
  for (let i = 0x400; i < Math.min(u8.length - 8, 0x100000); i++) {
    // 01 FF FF FF FF  + uint32
    if (u8[i] === 0x01 && u8[i + 1] === 0xff && u8[i + 2] === 0xff && u8[i + 3] === 0xff && u8[i + 4] === 0xff) {
      starts.push(i);
    }
  }
  return starts;
}

function sm2ExtractNamesInRange(view, u8, from, to) {
  const names = [];
  const end = Math.min(to, u8.length - 12);
  for (let i = from; i < end; i++) {
    if (u8[i] !== 1 || u8[i + 1] !== 0 || u8[i + 2] !== 0 || u8[i + 3] !== 0) continue;
    const nchars = view.getInt32(i + 4, true);
    if (nchars < 3 || nchars > 120) continue;
    if (i + 8 + nchars * 2 > end) continue;
    let ok = true;
    let hasCyr = false;
    const chars = [];
    for (let k = 0; k < nchars; k++) {
      const cp = view.getUint16(i + 8 + k * 2, true);
      if (cp < 0x20) { ok = false; break; }
      if (cp > 0x7e && (cp < 0x400 || cp > 0x45f) && cp !== 0xb0) { ok = false; break; }
      if (cp >= 0x400 && cp <= 0x45f) hasCyr = true;
      chars.push(String.fromCharCode(cp));
    }
    if (!ok || !hasCyr) continue;
    names.push({ offset: i, end: i + 8 + nchars * 2, name: chars.join("") });
    i = i + 8 + nchars * 2 - 1;
  }
  return names;
}

function sm2ReadChannelCount(view, from, to) {
  for (let i = from; i < Math.min(from + 0x200, to - 8); i++) {
    const n = view.getInt32(i, true);
    if (n >= 1 && n <= 40) {
      const prev = view.getInt32(i - 4, true);
      if (prev > 50 && prev < 50_000_000) return n;
    }
  }
  return 0;
}

/** Компактный формат 2 каналов: rpm + thr в одном кадре 24 байта.
 *  В потоке SMFS иногда вставлены маркеры 9..33 байт — шаг не всегда ровно 24. */
function sm2ExtractCompact2ch(view, from, to) {
  function readFrame(off) {
    if (off + 24 > to) return null;
    const rpm = sm2ReadF64(view, off);
    const t = sm2ReadI32(view, off + 8);
    let thr = sm2ReadF64(view, off + 12);
    const t2 = sm2ReadI32(view, off + 20);
    if (!sm2Ok(rpm) || rpm < 400 || rpm > 9000) return null;
    if (!Number.isFinite(t) || t < 0 || t > 3_600_000) return null;
    if (!sm2Ok(thr) || thr < -0.5 || thr > 105) return null;
    if (Number.isFinite(t2) && t2 > 0 && t2 < 3_600_000 && Math.abs(t2 - t) > 5000) return null;
    if (thr >= 0 && thr <= 1.5) thr *= 100;
    if (Math.abs(thr) < 1e-9) thr = 0;
    return { t: t / 1000, rpm, pedal: thr, off };
  }

  function nextFrame(afterOff, tLast) {
    // сначала ожидаемый шаг 24, затем поиск маркера/сдвига
    for (const d of [24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 36, 40, 48, 56, 57]) {
      const f = readFrame(afterOff + d);
      if (!f) continue;
      if (tLast != null) {
        const dt = f.t - tLast;
        if (dt < -0.05 || dt > 3.0) continue;
      }
      return f;
    }
    for (let d = 1; d <= 64; d++) {
      const f = readFrame(afterOff + d);
      if (!f) continue;
      if (tLast != null) {
        const dt = f.t - tLast;
        if (dt < -0.05 || dt > 3.0) continue;
      }
      return f;
    }
    return null;
  }

  // Старт: первый кадр, за которым идут ещё ≥3 с непрерывным временем
  let startOff = -1;
  const scanTo = Math.min(from + 0x900, to - 24);
  for (let off = from; off <= scanTo; off++) {
    const f0 = readFrame(off);
    if (!f0) continue;
    let ok = 1;
    let last = f0;
    for (let k = 0; k < 4; k++) {
      const n = nextFrame(last.off, last.t);
      if (!n) break;
      ok++;
      last = n;
    }
    if (ok >= 5) {
      startOff = off;
      break;
    }
  }
  if (startOff < 0) return [];

  const series = [];
  let cur = readFrame(startOff);
  if (!cur) return [];
  series.push(cur);
  while (cur.off + 24 <= to) {
    const n = nextFrame(cur.off, cur.t);
    if (!n) break;
    series.push(n);
    cur = n;
  }

  if (series.length < 5) return [];

  const dts = [];
  for (let i = 1; i < series.length; i++) {
    const dt = series[i].t - series[i - 1].t;
    if (dt > 1e-6) dts.push(dt);
  }
  dts.sort((a, b) => a - b);
  const med = dts[Math.floor(dts.length / 2)] || 0;
  // типичный SM OBD ~7–10 Гц (0.1–0.15 с); отсекаем явный мусор
  if (med < 0.02 || med > 2.0) return [];

  return series.map(({ t, rpm, pedal }) => ({ t, rpm, pedal }));
}

/** Формат N каналов: кадр = N × (f64, i64 time, i64) */
function sm2ExtractMultiCh(view, from, to, nCh, names) {
  const stride = nCh * SM2_SAMPLE;
  const anchors = [];
  for (let off = from; off + SM2_SAMPLE <= to; off += 8) {
    const rpm = sm2ReadF64(view, off);
    const t = sm2ReadI64(view, off + 8);
    if (sm2Ok(rpm) && rpm >= 400 && rpm <= 8500 && t >= 50 && t <= 86_400_000) {
      anchors.push({ off, rpm, t });
    }
  }
  if (anchors.length < 5) return [];

  // медианный шаг между якорями
  const deltas = [];
  for (let i = 1; i < anchors.length; i++) {
    const d = anchors[i].off - anchors[i - 1].off;
    const dt = anchors[i].t - anchors[i - 1].t;
    if (d > 0 && d % SM2_SAMPLE === 0 && dt > 0 && dt < 5000) deltas.push(d);
  }
  if (!deltas.length) return [];
  deltas.sort((a, b) => a - b);
  let strideGuess = deltas[Math.floor(deltas.length / 2)];
  if (strideGuess !== stride) {
    // если угадали иначе — доверяем частому шагу
    const freq = new Map();
    for (const d of deltas) freq.set(d, (freq.get(d) || 0) + 1);
    let best = strideGuess; let bestN = 0;
    for (const [d, n] of freq) if (n > bestN) { best = d; bestN = n; }
    strideGuess = best;
  }
  const chCount = strideGuess / SM2_SAMPLE;
  if (!Number.isInteger(chCount) || chCount < 1) return [];

  // rpm обычно канал 0 в компактных OBD-логах; иначе голосуем
  let rpmCh = 0;
  const pedalNameIdx = names.findIndex((n) => sm2NameScore(n.name, SM2_PEDAL_KEYS) >= 40);
  const thrNameIdx = names.findIndex((n) => sm2NameScore(n.name, SM2_THROTTLE_KEYS) >= 40);

  const rows = [];
  const seen = new Set();
  for (const a of anchors) {
    const rec = a.off - rpmCh * SM2_SAMPLE;
    if (rec < from || rec + strideGuess > to) continue;
    if (seen.has(a.t)) continue;
    seen.add(a.t);
    const chans = [];
    for (let c = 0; c < chCount; c++) chans.push(sm2ReadF64(view, rec + c * SM2_SAMPLE));

    // выбрать канал педали/дросселя
    let pedalCh = thrNameIdx >= 0 && thrNameIdx < chCount ? thrNameIdx
      : pedalNameIdx >= 0 && pedalNameIdx < chCount ? pedalNameIdx : -1;
    if (pedalCh < 0 || pedalCh === rpmCh) {
      let best = -1; let bestS = -1e9;
      for (let c = 0; c < chCount; c++) {
        if (c === rpmCh) continue;
        const v = chans[c];
        if (!sm2Ok(v)) continue;
        let x = v;
        if (x >= 0 && x <= 1.5) x *= 100;
        if (x < -1 || x > 105) continue;
        let s = 10;
        if (x <= 100.5) s += 20;
        if (x > 50) s += 20;
        if (s > bestS) { bestS = s; best = c; }
      }
      pedalCh = best >= 0 ? best : Math.min(1, chCount - 1);
    }
    let pedal = chans[pedalCh];
    if (pedal >= 0 && pedal <= 1.5) pedal *= 100;
    if (!sm2Ok(pedal) || pedal < 0 || pedal > 105) continue;
    rows.push({ t: a.t / 1000, rpm: a.rpm, pedal });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

/**
 * Самый длинный непрерывный разгон при «педали в пол».
 * Порог адаптивный (не обязательно 100%).
 * Разрыв при падении оборотов (переключение передачи).
 */
function sm2FindBestWotPull(rows, opts = {}) {
  if (!rows || rows.length < 5) return null;
  const pedals = rows.map((r) => r.pedal).filter((v) => sm2Ok(v));
  const maxPedal = Math.max(...pedals);
  // «в пол»: не ниже 85% от максимума в этом прогоне, но не ниже floor
  const floor = opts.fullFloor ?? 70;
  const ratio = opts.fullRatio ?? 0.88;
  const fullThr = Math.max(floor, maxPedal * ratio);
  const releaseThr = Math.min(fullThr * 0.55, opts.releasePedal ?? 40);
  const minDur = opts.minDuration ?? 0.8;
  const minRpmGain = opts.minRpmGain ?? 300;

  const candidates = [];
  let i = 0;
  while (i < rows.length) {
    while (i < rows.length && !(rows[i].pedal >= fullThr)) i++;
    if (i >= rows.length) break;
    let start = i;
    while (i < rows.length && rows[i].pedal > releaseThr) i++;
    let end = i - 1;
    if (end - start < 4) continue;

    // Разбить по падениям оборотов (вкл. передачи) внутри WOT
    let segStart = start;
    for (let k = start + 1; k <= end; k++) {
      const drop = rows[k - 1].rpm - rows[k].rpm;
      const isBreak = drop > 250 || (k === end);
      if (!isBreak) continue;
      const segEnd = isBreak && drop > 250 ? k - 1 : end;
      if (segEnd - segStart >= 4) {
        // усечь до монотонного роста оборотов (лучший кусок)
        const rising = sm2LongestRising(rows, segStart, segEnd);
        if (rising) {
          const dur = rows[rising.b].t - rows[rising.a].t;
          const gain = rows[rising.b].rpm - rows[rising.a].rpm;
          if (dur >= minDur && gain >= minRpmGain) {
            candidates.push({
              a: rising.a,
              b: rising.b,
              dur,
              gain,
              score: dur * Math.sqrt(Math.max(gain, 1)),
            });
          }
        }
      }
      segStart = k;
    }
  }

  if (!candidates.length) {
    // fallback: просто самый длинный рост оборотов при педали выше медианы верхней половины
    const sorted = [...pedals].sort((a, b) => a - b);
    const hi = sorted[Math.floor(sorted.length * 0.75)];
    const thr2 = Math.max(floor, hi);
    let a = 0;
    for (let k = 1; k < rows.length; k++) {
      if (rows[k].pedal < thr2 || rows[k].rpm + 200 < rows[k - 1].rpm) {
        const rising = sm2LongestRising(rows, a, k - 1);
        if (rising) {
          const dur = rows[rising.b].t - rows[rising.a].t;
          const gain = rows[rising.b].rpm - rows[rising.a].rpm;
          if (dur >= minDur && gain >= minRpmGain) {
            candidates.push({ a: rising.a, b: rising.b, dur, gain, score: dur * Math.sqrt(gain) });
          }
        }
        a = k;
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((x, y) => y.score - x.score);
  const best = candidates[0];
  return {
    rows: rows.slice(best.a, best.b + 1),
    fullThr,
    maxPedal,
    dur: best.dur,
    gain: best.gain,
  };
}

function sm2LongestRising(rows, from, to) {
  let bestA = from;
  let bestB = from;
  let a = from;
  for (let k = from + 1; k <= to; k++) {
    if (rows[k].rpm + 30 < rows[k - 1].rpm) {
      if (k - 1 - a > bestB - bestA) { bestA = a; bestB = k - 1; }
      a = k;
    }
  }
  if (to - a > bestB - bestA) { bestA = a; bestB = to; }
  if (bestB - bestA < 3) return null;
  return { a: bestA, b: bestB };
}

/**
 * @returns {{ sessions: Array<{ label: string, headers: string[], rows: number[][], meta: object }> }}
 */
function parseSm2ArrayBuffer(buffer) {
  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (u8.length < 0x600) throw new Error("Файл .sm2 слишком короткий");
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== "SMFS") throw new Error("Это не лог Scanmatik (нет SMFS)");

  const toc = sm2ParseToc(view, u8);
  let starts = sm2FindSessionStarts(u8);
  if (!starts.length) starts = [0x400];

  // TOC в файле обычно в хронологическом порядке; UI Сканматика — новые сверху.
  // Сопоставляем сессии с TOC по порядку появления в файле.
  const sessions = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : u8.length;
    const tocEntry = toc[s] || null;
    const label = tocEntry?.label || `Прогон ${s + 1}`;

    const names = sm2ExtractNamesInRange(view, u8, from, to);
    let nCh = sm2ReadChannelCount(view, from, Math.min(from + 0x300, to));
    if (!nCh) {
      nCh = Math.max(2, names.filter((n) =>
        sm2NameScore(n.name, SM2_RPM_KEYS) + sm2NameScore(n.name, SM2_PEDAL_KEYS) + sm2NameScore(n.name, SM2_THROTTLE_KEYS) > 0
      ).length || 2);
    }

    // Данные сразу после UTF-16 имён (+ короткий заголовок блока)
    const metaStart = names.length ? names[names.length - 1].end : from + 0x100;
    let samples = [];
    if (nCh <= 2) {
      samples = sm2ExtractCompact2ch(view, metaStart, to);
      if (samples.length < 5) samples = sm2ExtractCompact2ch(view, from + 0x100, to);
      if (samples.length < 5) samples = sm2ExtractMultiCh(view, metaStart, to, Math.max(nCh, 2), names);
    } else {
      samples = sm2ExtractMultiCh(view, metaStart, to, nCh, names);
      if (samples.length < 5) samples = sm2ExtractCompact2ch(view, metaStart, to);
    }

    if (samples.length < 5) continue;

    const rpmName = names.find((n) => sm2NameScore(n.name, SM2_RPM_KEYS) >= 40)?.name || "Обороты двигателя";
    const pedalName =
      names.find((n) => sm2NameScore(n.name, SM2_PEDAL_KEYS) >= 40)?.name ||
      names.find((n) => sm2NameScore(n.name, SM2_THROTTLE_KEYS) >= 40)?.name ||
      "Педаль/дроссель";

    const headers = ["Time", rpmName, pedalName];
    const rows = samples.map((r) => [r.t, r.rpm, r.pedal]);
    const duration = rows.length ? rows[rows.length - 1][0] - rows[0][0] : 0;

    sessions.push({
      label,
      headers,
      rows,
      samples,
      meta: {
        format: "sm2-obd2",
        channelCount: nCh,
        names: names.map((n) => n.name),
        samples: rows.length,
        tocIndex: s,
        filetime: tocEntry?.filetime ?? null,
        duration,
      },
    });
  }

  if (!sessions.length) throw new Error("В .sm2 не найдены кадры OBD-II (обороты/педаль)");

  // Для сравнения — в том же порядке, что TOC (как записано), затем по FILETIME
  sessions.sort((a, b) => {
    const fa = a.meta.filetime || 0;
    const fb = b.meta.filetime || 0;
    if (fa && fb && fa !== fb) return fa - fb;
    return (a.meta.tocIndex || 0) - (b.meta.tocIndex || 0);
  });

  return { sessions, toc };
}

/** Вырезать лучший WOT из сессии → rows [t,rpm,pedal] */
function sm2SessionToWotRows(session, opts) {
  const pull = sm2FindBestWotPull(session.samples || session.rows.map((r) => ({
    t: r[0], rpm: r[1], pedal: r[2],
  })), opts);
  if (!pull) return null;
  const t0 = pull.rows[0].t;
  return {
    headers: session.headers,
    rows: pull.rows.map((r) => [r.t - t0, r.rpm, r.pedal]),
    absRows: pull.rows.map((r) => [r.t, r.rpm, r.pedal]),
    label: session.label,
    meta: {
      ...session.meta,
      fullThr: pull.fullThr,
      maxPedal: pull.maxPedal,
      wotDuration: pull.dur,
      rpmGain: pull.gain,
    },
  };
}
