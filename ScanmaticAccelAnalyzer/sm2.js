/**
 * Парсер Scanmatik SMFS (.sm2) — OBD-II Livedata.
 *
 * Особенности файла:
 *   • магия SMFS; TOC с @0x19 по 20 байт (unk, FILETIME, type, size) до паддинга FF.
 *     Байт @0x10 часто = 2 при 3–6 реальных прогонах — длину TOC по нему не брать.
 *   • сессии: маркер 01 FF FF FF FF с 0x400; хвостовые пустые блоки 0x400 без имён — отброс.
 *   • 2 канала (компакт): f64 rpm | i32 t_ms | f64 thr | i32 t_next  (24 Б, шаг 24…33).
 *   • N>2: на канал f64 | i64 t_ms | i64         (24×N).
 *   • ПК ~7–10 Гц (dt≈0.13 с). Телефон ~4 Гц (dt≈0.26 с) и паузы 7–12 с — это не один разгон.
 *   • Ford Absolute Throttle WOT ≈ 85.88% (219/255), не 100%.
 *   • в хвосте сессии иногда мусорные timestamp (часы) — отрезаем основной кластер времени.
 *
 * Раскладки, на которых учится детектор:
 *   2ch ПК:  обороты + абсолютное положение дросселя
 *   3ch:     обороты + скорость + дроссель
 *   4ch:     MAP + обороты + УОЗ + лямбда (педали нет — только рост оборотов)
 *   5ch:     обороты + скорость + УОЗ + дроссель + лямбда
 */

/** Шум OBD (об/мин), не переключение. Телефон ±40–50, ПК-блип перед разгоном ~60–120. */
const SM2_OBD_DIP = 60;
/** Сброс оборотов на другую передачу. */
const SM2_GEAR_DROP = 250;
/** Пауза записи (телефон 7–12 с) — новый участок. */
const SM2_GAP_SEC = 2.5;
/** Разрыв timestamp, после которого кадры считаем мусором. */
const SM2_JUNK_GAP = 90;

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

const SM2_RPM_KEYS = ["оборот", "rpm", "engine speed", "частота вращения", "коленвал", "engine rpm"];
const SM2_PEDAL_KEYS = [
  "педаль", "pedal", "accelerator", "акселер", "положение педали", "app", "запрос момента",
  "accelerator pedal", "pedal position",
];
const SM2_THROTTLE_KEYS = [
  "дроссел", "throttle", "абсолютное положение дросселя", "положение дросселя", "tps",
  "throttle position", "absolute throttle",
];
/** Запасной канал «в пол», если педали/дросселя нет. MAP/разрежение — не педаль. */
const SM2_LOAD_KEYS = [
  "расчетная нагрузка", "расчётная нагрузка", "calculated load", "engine load",
  "нагрузка двигателя", "absolute load",
];
const SM2_MAP_KEYS = [
  "разрежение", "впускном коллекторе", "manifold", "map sensor", "давление во впуск",
];
const SM2_SPEED_KEYS = [
  "скорость автомобиля", "скорость тс", "vehicle speed", "vss", "скорость", "speed", "км/ч", "km/h",
];

/** TOC: записи по 20 байт с @0x19 до паддинга 0xFF. Байт @0x10 часто = 2 даже при 3–5 прогонах. */
function sm2ParseToc(view, u8) {
  const entries = [];
  let off = 0x19;
  for (let i = 0; i < 32; i++) {
    if (off + 20 > u8.length) break;
    if (u8[off] === 0xff && u8[off + 1] === 0xff) break;
    const unk = sm2ReadU32(view, off);
    const ft = sm2ReadI64(view, off + 4);
    const type = sm2ReadU32(view, off + 12);
    const size = sm2ReadU32(view, off + 16);
    const date = sm2FileTimeToDate(ft);
    if (!(size > 64 && size < u8.length * 2)) break;
    entries.push({
      index: i,
      unk,
      type,
      size,
      filetime: ft,
      date,
      label: date ? sm2FormatStamp(date) : `Прогон ${i + 1}`,
    });
    off += 20;
  }
  return entries;
}

/** Начала блоков «Переменные». Хвостовые пустые маркеры (без имён каналов) отбрасываем. */
function sm2FindSessionStarts(u8, view) {
  if (!view) view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const raw = [];
  for (let i = 0x400; i < Math.min(u8.length - 8, 0x400000); i++) {
    if (u8[i] === 0x01 && u8[i + 1] === 0xff && u8[i + 2] === 0xff && u8[i + 3] === 0xff && u8[i + 4] === 0xff) {
      raw.push(i);
    }
  }
  return raw.filter((from, idx) => {
    const to = idx + 1 < raw.length ? raw[idx + 1] : u8.length;
    if (to - from < 0x200) return false;
    const names = sm2ExtractNamesInRange(view, u8, from, Math.min(from + 0xA00, to));
    return names.length >= 1;
  });
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
    let hasLat = false;
    const chars = [];
    for (let k = 0; k < nchars; k++) {
      const cp = view.getUint16(i + 8 + k * 2, true);
      if (cp < 0x20) { ok = false; break; }
      if (cp > 0x7e && (cp < 0x400 || cp > 0x45f) && cp !== 0xb0) { ok = false; break; }
      if (cp >= 0x400 && cp <= 0x45f) hasCyr = true;
      if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) hasLat = true;
      chars.push(String.fromCharCode(cp));
    }
    if (!ok || (!hasCyr && !hasLat)) continue;
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

  const compactRows = series.map(({ t, rpm, pedal }) => ({ t, rpm, pedal }));
  return sm2KeepMainTimeCluster(compactRows);
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

  const rpmNameIdx = names.findIndex((n) => sm2NameScore(n.name, SM2_RPM_KEYS) >= 40);
  const pedalNameIdx = names.findIndex((n) => sm2NameScore(n.name, SM2_PEDAL_KEYS) >= 40);
  const thrNameIdx = names.findIndex((n) => sm2NameScore(n.name, SM2_THROTTLE_KEYS) >= 40);
  const loadNameIdx = names.findIndex((n) => sm2NameScore(n.name, SM2_LOAD_KEYS) >= 40);
  const mapNameIdx = names.findIndex((n) => sm2NameScore(n.name, SM2_MAP_KEYS) >= 40);
  let rpmCh = rpmNameIdx >= 0 && rpmNameIdx < chCount ? rpmNameIdx : 0;
  if (mapNameIdx >= 0 && rpmCh === mapNameIdx) {
    rpmCh = rpmNameIdx >= 0 ? rpmNameIdx : 1;
  }
  let pedalCh = -1;
  if (pedalNameIdx >= 0 && pedalNameIdx < chCount && pedalNameIdx !== rpmCh) pedalCh = pedalNameIdx;
  else if (thrNameIdx >= 0 && thrNameIdx < chCount && thrNameIdx !== rpmCh) pedalCh = thrNameIdx;
  else if (loadNameIdx >= 0 && loadNameIdx < chCount && loadNameIdx !== rpmCh && loadNameIdx !== mapNameIdx) {
    pedalCh = loadNameIdx;
  }

  const rows = [];
  const seen = new Set();
  let lastPedal = NaN;
  for (const a of anchors) {
    const rec = a.off - rpmCh * SM2_SAMPLE;
    if (rec < from || rec + strideGuess > to) continue;
    if (seen.has(a.t)) continue;
    seen.add(a.t);
    const chans = [];
    for (let c = 0; c < chCount; c++) chans.push(sm2ReadF64(view, rec + c * SM2_SAMPLE));

    const rpmVal = chans[rpmCh];
    if (!sm2Ok(rpmVal) || rpmVal < 400 || rpmVal > 9000) continue;

    let pedal = NaN;
    if (pedalCh >= 0) {
      let v = chans[pedalCh];
      if (sm2Ok(v) && Math.abs(v) < 1e-8) v = 0;
      if (sm2Ok(v) && v >= 0 && v <= 1.5) v *= 100;
      if (sm2Ok(v) && v >= -0.5 && v <= 105) pedal = v;
      else if (sm2Ok(lastPedal)) pedal = lastPedal;
      lastPedal = pedal;
    }

    const speedNameIdx = names.findIndex((n) => sm2NameScore(n.name, SM2_SPEED_KEYS) >= 40);
    let speed = null;
    if (speedNameIdx >= 0 && speedNameIdx < chCount && speedNameIdx !== rpmCh && speedNameIdx !== pedalCh) {
      const sv = chans[speedNameIdx];
      if (sm2Ok(sv) && sv >= 0 && sv <= 350) speed = sv;
    } else {
      for (let c = 0; c < chCount; c++) {
        if (c === rpmCh || c === pedalCh) continue;
        if (c === mapNameIdx || c === loadNameIdx) continue;
        const sv = chans[c];
        if (!sm2Ok(sv) || sv < 5 || sv > 280) continue;
        // скорость обычно растёт вместе с оборотами, диапазон не как педаль
        if (sv > 105 || (sv > 30 && sv < 200)) { speed = sv; break; }
      }
    }
    let load = NaN;
    if (mapNameIdx >= 0 && mapNameIdx < chCount && mapNameIdx !== rpmCh) {
      const mv = chans[mapNameIdx];
      if (sm2Ok(mv) && mv >= 0 && mv < 400) load = mv;
    } else if (loadNameIdx >= 0 && loadNameIdx < chCount && loadNameIdx !== pedalCh && loadNameIdx !== rpmCh) {
      const lv = chans[loadNameIdx];
      if (sm2Ok(lv) && lv >= -5 && lv <= 200) load = lv;
    }
    rows.push({ t: a.t / 1000, rpm: rpmVal, pedal, speed, load });
  }
  rows.sort((a, b) => a.t - b.t);
  sm2InterpSpeedGaps(rows);
  const clustered = sm2KeepMainTimeCluster(rows);
  sm2SanitizeSpeed(clustered);
  return clustered;
}

/** Короткие дыры OBD в канале скорости (1–2 кадра, <1.2 с) — линейно. */
function sm2InterpSpeedGaps(rows) {
  if (!rows || rows.length < 3) return;
  for (let i = 1; i < rows.length; i++) {
    if (Number.isFinite(rows[i].speed)) continue;
    if (!Number.isFinite(rows[i - 1].speed)) continue;
    let j = i + 1;
    while (j < rows.length && !Number.isFinite(rows[j].speed)) j++;
    if (j >= rows.length) break;
    const span = rows[j].t - rows[i - 1].t;
    if (!(span > 0) || span > 1.2) {
      i = j;
      continue;
    }
    for (let k = i; k < j; k++) {
      const u = (rows[k].t - rows[i - 1].t) / span;
      rows[k].speed = rows[i - 1].speed + u * (rows[j].speed - rows[i - 1].speed);
    }
    i = j;
  }
}

/**
 * Основной кластер времени: отбрасываем хвост, где i64 прочитался как мусор
 * (скачки на десятки тысяч секунд при живой сессии в пределах минут).
 */
function sm2KeepMainTimeCluster(rows) {
  if (!rows || rows.length < 6) return rows || [];
  const ts = rows.map((r) => r.t).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (ts.length < 6) return rows;
  let bestA = 0;
  let bestB = 0;
  let a = 0;
  for (let i = 1; i <= ts.length; i++) {
    if (i === ts.length || ts[i] - ts[i - 1] > SM2_JUNK_GAP) {
      if (i - 1 - a > bestB - bestA) {
        bestA = a;
        bestB = i - 1;
      }
      a = i;
    }
  }
  const lo = ts[bestA];
  const hi = ts[bestB];
  return rows.filter((r) => r.t >= lo - 1 && r.t <= hi + 1);
}

/** Сканматик иногда пишет «скорость» как застывшее 219/255·100, пока растут обороты. */
function sm2DropFrozenSpeed(rows) {
  if (!rows || rows.length < 6) return;
  const withSp = rows.filter((r) => Number.isFinite(r.speed) && r.speed > 0);
  if (withSp.length < 4) return;
  const rpmSpan = Math.max(...rows.map((r) => r.rpm)) - Math.min(...rows.map((r) => r.rpm));
  const speeds = withSp.map((r) => r.speed);
  const spSpan = Math.max(...speeds) - Math.min(...speeds);
  const mid = speeds.slice().sort((a, b) => a - b)[Math.floor(speeds.length / 2)];
  const frozen = speeds.filter((s) => Math.abs(s - mid) < 1.5).length / speeds.length;
  const fordWot = Math.abs(mid - (219 / 255) * 100) < 1.2;
  if (rpmSpan > 600 && spSpan < 4) {
    for (const r of rows) r.speed = null;
    return;
  }
  if (rpmSpan >= 1200 && ((spSpan < 10 && frozen > 0.6) || frozen > 0.75 || (fordWot && frozen > 0.5 && spSpan < 15))) {
    for (const r of rows) r.speed = null;
  }
}

function sm2SanitizeSpeed(rows) {
  if (!rows || rows.length < 6) return;
  sm2DropFrozenSpeed(rows);
  const both = rows.filter((r) => Number.isFinite(r.speed) && Number.isFinite(r.pedal));
  if (both.length >= 8) {
    const close = both.filter((r) => Math.abs(r.speed - r.pedal) < 3).length;
    if (close / both.length > 0.7) {
      for (const r of rows) r.speed = null;
    }
  }
}

function sm2LongestRising(rows, from, to) {
  let bestA = from;
  let bestB = from;
  let a = from;
  for (let k = from + 1; k <= to; k++) {
    if (rows[k].rpm + SM2_OBD_DIP < rows[k - 1].rpm) {
      if (k - 1 - a > bestB - bestA) { bestA = a; bestB = k - 1; }
      a = k;
    }
  }
  if (to - a > bestB - bestA) { bestA = a; bestB = to; }
  if (bestB - bestA < 2) return null;
  return sm2TrimClimb(rows, bestA, bestB);
}

/** Конец участка — последняя полка у максимума оборотов (не хвост после срыва). */
function sm2TrimClimb(rows, a, b) {
  if (b - a < 3) return { a, b };
  let maxRpm = rows[a].rpm;
  for (let i = a; i <= b; i++) if (rows[i].rpm > maxRpm) maxRpm = rows[i].rpm;
  let end = a;
  for (let i = a; i <= b; i++) {
    if (rows[i].rpm >= maxRpm - 12) end = i;
  }
  return { a, b: Math.min(b, Math.max(end, a)) };
}

/** Все участки роста оборотов в [from..to], с допуском шума OBD. */
function sm2AllRisingSegments(rows, from, to) {
  const segs = [];
  if (to - from < 2) return segs;
  let a = from;
  for (let k = from + 1; k <= to; k++) {
    const dropped = rows[k].rpm + SM2_OBD_DIP < rows[k - 1].rpm;
    if (dropped || k === to) {
      const b = dropped ? k - 1 : to;
      if (b - a >= 2) {
        const trim = sm2TrimClimb(rows, a, b);
        if (trim.b - trim.a >= 2) segs.push(trim);
      }
      a = k;
    }
  }
  return sm2MergeRiseSegs(rows, segs);
}

/** Склеить соседние наборы, разорванные блипом OBD, а не переключением. */
function sm2MergeRiseSegs(rows, segs) {
  if (!segs || segs.length < 2) return segs || [];
  const out = [{ a: segs[0].a, b: segs[0].b }];
  for (let i = 1; i < segs.length; i++) {
    const prev = out[out.length - 1];
    const cur = segs[i];
    const gap = cur.a - prev.b;
    const drop = rows[prev.b].rpm - rows[cur.a].rpm;
    const stillUp = rows[cur.b].rpm > rows[prev.b].rpm + 80;
    const restartClose = Math.abs(rows[cur.a].rpm - rows[prev.b].rpm) < 90;
    const gear = sm2IsGearChange(rows, cur.a) || (gap >= 1 && sm2IsGearChange(rows, prev.b + 1));
    if (!gear && gap >= 1 && gap <= 4 && drop < 140 && stillUp && restartClose) {
      prev.b = cur.b;
    } else {
      out.push({ a: cur.a, b: cur.b });
    }
  }
  return out.map((s) => sm2TrimClimb(rows, s.a, s.b)).filter((s) => s.b - s.a >= 2);
}

/** Переключение: резкий сброс об/мин или скачок rpm/скорость при живом VSS. */
function sm2IsGearChange(rows, k) {
  if (k <= 0 || k >= rows.length) return false;
  const drop = rows[k - 1].rpm - rows[k].rpm;
  if (drop > SM2_GEAR_DROP) return true;
  const s0 = rows[k - 1].speed;
  const s1 = rows[k].speed;
  if (!(s0 > 8) || !(s1 > 8) || drop < 80) return false;
  const r0 = rows[k - 1].rpm / s0;
  const r1 = rows[k].rpm / s1;
  if (!(r0 > 1) || !(r1 > 1)) return false;
  return Math.abs(r1 - r0) / r0 > 0.18;
}

/** Учёт редкого OBD: длительность + запас на несколько кадров (телефон ~0.26 с). */
function sm2MeetsMinDur(dur, minDur, medDt = 0.12, n = 0) {
  if (!Number.isFinite(dur) || !Number.isFinite(minDur)) return false;
  const dt = Number(medDt) || 0.12;
  const slack = Math.max(0.45, 4 * dt);
  if (dur + slack >= minDur) return true;
  // Короткий плотный кусок (n кадров ≈ minDur при дырявом OBD)
  if (n >= 8 && n * dt + slack >= minDur * 0.7) return true;
  return false;
}

/**
 * Ползунки оборотов: участок должен реально зайти в окно [lo, hi],
 * не «зацепить» его на 50 об/мин.
 */
function sm2PassesRpmWindow(rpm0, rpm1, lo = 1000, hi = 8000) {
  if (!Number.isFinite(rpm0) || !Number.isFinite(rpm1) || !(hi > lo)) return false;
  const a = Math.min(rpm0, rpm1);
  const b = Math.max(rpm0, rpm1);
  const overlap = Math.min(b, hi) - Math.max(a, lo);
  if (!(overlap > 0)) return false;
  const span = b - a;
  const win = hi - lo;
  const need = Math.min(span, Math.max(350, Math.min(900, win * 0.18)));
  return overlap >= need - 1;
}

/** Оставить кадры участка, чьи обороты попадают в окно фильтра. */
function sm2CropToRpmWindow(rows, a, b, lo, hi) {
  if (!(b > a)) return null;
  let s = -1;
  let e = -1;
  for (let i = a; i <= b; i++) {
    const r = rows[i].rpm;
    if (!Number.isFinite(r)) continue;
    if (r >= lo - 20 && r <= hi + 20) {
      if (s < 0) s = i;
      e = i;
    }
  }
  if (s < 0 || e - s < 2) return null;
  return { a: s, b: e };
}

/** @deprecated имя; то же, что sm2PassesRpmWindow */
function sm2CoversRpmBand(rpm0, rpm1, lo = 1000, hi = 8000) {
  return sm2PassesRpmWindow(rpm0, rpm1, lo, hi);
}

function sm2SegMedDt(rows, a, b) {
  const dts = [];
  for (let i = a + 1; i <= b; i++) {
    const dt = rows[i].t - rows[i - 1].t;
    if (dt > 1e-6 && dt < 8) dts.push(dt);
  }
  if (!dts.length) return 0.12;
  dts.sort((x, y) => x - y);
  return dts[Math.floor(dts.length / 2)];
}

function sm2IsGap(rows, k, gapSec) {
  if (k <= 0 || k >= rows.length) return false;
  const dt = rows[k].t - rows[k - 1].t;
  if (!Number.isFinite(dt)) return false;
  if (dt < -0.2) return true;
  return dt > gapSec;
}

/** Есть ли в куске реальное плато дросселя у максимума (Ford ~86% пачками кадров). */
function sm2HasPedalPlateau(rows, from, to, maxP) {
  if (!(maxP >= 40) || to < from) return false;
  let n = 0;
  let t0 = null;
  let t1 = null;
  for (let i = from; i <= to; i++) {
    const v = rows[i].pedal;
    if (sm2Ok(v) && v >= maxP - 3.5) {
      n++;
      if (t0 == null) t0 = rows[i].t;
      t1 = rows[i].t;
    }
  }
  const dur = t0 != null ? t1 - t0 : 0;
  return n >= 8 || (n >= 5 && dur >= 1.15);
}

/**
 * Порог «высокой» педали/дросселя внутри вспышки записи.
 * Плато (ПК Ford 86%) → пол у максимума. Рампа телефона 52→80 без полки → от ~55% локального max.
 */
function sm2BurstLoadFloor(rows, from, to, pedalMinReq, pedalMax) {
  const vals = [];
  for (let i = from; i <= to; i++) {
    const v = rows[i].pedal;
    if (sm2Ok(v) && v <= pedalMax + 1.5) vals.push(v);
  }
  if (!vals.length) return null;
  const maxP = Math.max(...vals);
  if (!(maxP >= 28)) return null;
  const plateau = sm2HasPedalPlateau(rows, from, to, maxP);
  if (maxP >= pedalMinReq) {
    if (plateau) {
      return { floor: pedalMinReq, maxP, plateau: true };
    }
    const ramp = Math.min(pedalMinReq, Math.max(pedalMinReq * 0.55, maxP * 0.62));
    return { floor: ramp, maxP, plateau: false };
  }
  return {
    floor: Math.max(28, Math.min(pedalMinReq, maxP * 0.50)),
    maxP,
    plateau,
  };
}

function sm2CollectRuns(rows, from, to, inRun, mergeGap = 2) {
  const runs = [];
  let a = -1;
  for (let i = from; i <= to + 1; i++) {
    const ok = i <= to && inRun(i);
    if (ok && a < 0) a = i;
    if (!ok && a >= 0) {
      runs.push({ a, b: i - 1 });
      a = -1;
    }
  }
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.a - last.b <= mergeGap) last.b = r.b;
    else merged.push({ a: r.a, b: r.b });
  }
  return merged;
}

function sm2TrimStompAndLift(rows, from, to, floor, maxP, plateau) {
  let s = from;
  let e = to;
  while (s < e - 2) {
    const p = rows[s].pedal;
    if (!sm2Ok(p) || p < floor - 1.5) s++;
    else break;
  }
  while (e > s + 2) {
    const p = rows[e].pedal;
    const prev = rows[e - 1].pedal;
    if (!sm2Ok(p) || p < floor - 1.5 || (sm2Ok(prev) && prev - p > 12 && p < floor)) e--;
    else break;
  }
  if (e - s < 2) return { a: from, b: to };
  return { a: s, b: e };
}

function sm2SplitByGearAndGap(rows, from, to, gapSec) {
  const parts = [];
  let a = from;
  for (let k = from + 1; k <= to + 1; k++) {
    const atEnd = k > to;
    const drop = !atEnd && sm2IsGearChange(rows, k);
    const gap = !atEnd && sm2IsGap(rows, k, gapSec);
    if (!drop && !gap && !atEnd) continue;
    parts.push({ a, b: atEnd ? to : k - 1 });
    a = k;
  }
  return parts;
}

/**
 * Обрезка для отображения: участок, где педаль/дроссель удерживается
 * на стационарном максимуме (WOT), без раскатки и без отпускания.
 * На рампе без полки (телефон) возвращает весь ход в зоне высокой педали.
 */
function sm2ClipToWotHold(rows, from, to, pedalMin, pedalMax) {
  if (to - from < 2) return null;
  const info = sm2BurstLoadFloor(rows, from, to, pedalMin, pedalMax);
  if (!info) return { a: from, b: to };
  const runs = sm2CollectRuns(rows, from, to, (i) => {
    const v = rows[i].pedal;
    return sm2Ok(v) && v >= info.floor && v <= pedalMax + 1.5;
  });
  if (!runs.length) return { a: from, b: to };
  runs.sort((x, y) => (y.b - y.a) - (x.b - x.a) || x.a - y.a);
  const run = runs[0];
  return sm2TrimStompAndLift(rows, run.a, run.b, info.floor, info.maxP, info.plateau);
}

function sm2TimeBursts(rows, gapSec) {
  const bursts = [];
  let a = 0;
  for (let k = 1; k <= rows.length; k++) {
    const atEnd = k >= rows.length;
    const gap = !atEnd && sm2IsGap(rows, k, gapSec);
    if (!gap && !atEnd) continue;
    bursts.push({ a, b: atEnd ? rows.length - 1 : k - 1 });
    a = k;
  }
  return bursts;
}

function sm2SegPedalStats(rows, a, b) {
  const pvals = [];
  for (let i = a; i <= b; i++) {
    if (sm2Ok(rows[i].pedal)) pvals.push(rows[i].pedal);
  }
  if (!pvals.length) return null;
  const sorted = pvals.slice().sort((x, y) => x - y);
  return {
    n: pvals.length,
    min: sorted[0],
    med: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
    vals: pvals,
  };
}

/** Прирост скорости на участке; застывшие ~86 км/ч (подделка Ford TPS) не считаем. */
function sm2SegSpeedRise(rows, a, b) {
  const sp = [];
  for (let i = a; i <= b; i++) {
    const v = rows[i].speed;
    if (Number.isFinite(v) && v >= 0 && v <= 350) sp.push(v);
  }
  if (sp.length < 3) return 0;
  const lo = Math.min(...sp);
  const hi = Math.max(...sp);
  const span = hi - lo;
  const mid = sp.slice().sort((x, y) => x - y)[Math.floor(sp.length / 2)];
  const frozen = sp.filter((s) => Math.abs(s - mid) < 1.5).length / sp.length;
  if (frozen > 0.72 || span < 3.5) return 0;
  if (Math.abs(mid - (219 / 255) * 100) < 1.3 && span < 8) return 0;
  return span;
}

function sm2SegLoadStats(rows, a, b) {
  const vals = [];
  for (let i = a; i <= b; i++) {
    if (sm2Ok(rows[i].load)) vals.push(rows[i].load);
  }
  if (vals.length < 3) return null;
  return { min: Math.min(...vals), max: Math.max(...vals), med: vals.slice().sort((x, y) => x - y)[Math.floor(vals.length / 2)] };
}

function sm2BurstPedalMax(rows, from, to) {
  let m = -Infinity;
  for (let i = from; i <= to; i++) {
    const v = rows[i].pedal;
    if (sm2Ok(v) && v > m) m = v;
  }
  return Number.isFinite(m) ? m : NaN;
}

/**
 * Педаль/дроссель — жёсткий допуск по ползунку.
 * Если в логе максимум ниже ползунка (телефон 50%), порог опускается к этому максимуму.
 * Короткие «нажатия» 30–45% при живом WOT в файле не берутся.
 */
function sm2EffectivePedalMin(sessionMax, pedalMinReq) {
  if (Number.isFinite(sessionMax) && sessionMax < pedalMinReq && sessionMax >= 40) {
    return Math.max(40, sessionMax * 0.82);
  }
  return pedalMinReq;
}

function sm2PedalAdmitsPull(ped, { pedalMinReq, pedalMax }) {
  if (!ped || ped.n < 2) return false;
  const { med: pMed, max: pMax, vals } = ped;
  const highN = vals.filter((v) => v >= pedalMinReq - 0.5 && v <= pedalMax + 1.5).length;
  if (pMax < pedalMinReq - 0.5) return false;
  if (pMax > pedalMax + 1.5) return false;
  if (highN < 3 && !(highN >= 2 && pMed >= pedalMinReq * 0.75)) return false;
  return true;
}

function sm2NoPedalAdmitsPull(rows, a, b, { gain, rps, n, rpm0, rpm1 }) {
  if (rpm1 < 2400 && rpm0 < 1600) return false;
  if (gain < 700) return false;
  if (n < 8 && gain < 1200) return false;
  if (rps < 120) return false;
  return true;
}

/** Обрезка отображения: плато WOT / высокая рампа. Частичный газ — весь набор оборотов. */
function sm2MaybeCropDisplay(rows, a, b, pedalMinReq, pedalMax) {
  const info = sm2BurstLoadFloor(rows, a, b, pedalMinReq, pedalMax);
  if (!info) return { a, b };
  if (info.plateau || info.maxP >= Math.min(pedalMinReq, 55)) {
    const clip = sm2ClipToWotHold(rows, a, b, pedalMinReq, pedalMax);
    if (clip && clip.b - clip.a >= 2) {
      const cGain = rows[clip.b].rpm - rows[clip.a].rpm;
      if (cGain >= 150) return clip;
    }
  }
  return { a, b };
}

/**
 * Все непрерывные разгоны на одной передаче.
 * Ищем удержание высокой педали/дросселя (ползунок), затем полный набор оборотов на передаче.
 * Мелкие нажатия 30–45% не берутся. Обороты — окно фильтра: участок должен зайти в него,
 * на график режется по [rpmMin, rpmMax].
 */
function sm2FindAllWotPulls(rows, opts = {}) {
  if (!rows || rows.length < 4) return [];
  const pedals = rows.map((r) => r.pedal).filter((v) => sm2Ok(v));
  const hasPedal = pedals.length > 0;
  const maxPedal = hasPedal ? Math.max(...pedals) : NaN;
  const pedalMinReq = sm2EffectivePedalMin(maxPedal, opts.pedalMin ?? opts.fullFloor ?? 70);
  const pedalMax = opts.pedalMax ?? 100;
  const minDur = opts.minDuration ?? 3;
  const minRpmGain = opts.minRpmGain ?? 600;
  const rpmMin = opts.rpmMin ?? opts.rpmBandLo ?? 1000;
  const rpmMax = opts.rpmMax ?? opts.rpmBandHi ?? 8000;
  const gapSec = opts.gapSec ?? SM2_GAP_SEC;
  const maxDur = opts.maxDuration ?? 22;
  const minRps = opts.minRps ?? (hasPedal ? 40 : 80);

  const candidates = [];
  const considerSeg = (seg) => {
    let a = seg.a;
    let b = seg.b;
    if (b - a < 2) return;
    const n0 = b - a + 1;
    const dur0 = rows[b].t - rows[a].t;
    const rpm0 = rows[a].rpm;
    const rpm1raw = rows[b].rpm;
    const gain0 = rpm1raw - rpm0;
    const medDt = sm2SegMedDt(rows, a, b);
    const rps0 = dur0 > 1e-6 ? gain0 / dur0 : 0;
    const ped0 = hasPedal ? sm2SegPedalStats(rows, a, b) : null;
    const needGain = hasPedal ? minRpmGain : Math.max(minRpmGain, 700);
    const full = gain0 >= 1200 && rps0 >= 180 && n0 >= 6;
    const durOk = sm2MeetsMinDur(dur0, minDur, medDt, n0);
    if (!durOk && !full) return;
    if (dur0 > maxDur && !full) return;
    if (!(gain0 >= needGain) && !full) return;
    if (rps0 < minRps && !full && gain0 < 900) return;
    if (!sm2PassesRpmWindow(rpm0, rpm1raw, rpmMin, rpmMax)) return;
    if (hasPedal) {
      if (!sm2PedalAdmitsPull(ped0, { pedalMinReq, pedalMax })) return;
    } else if (!sm2NoPedalAdmitsPull(rows, a, b, { gain: gain0, rps: rps0, n: n0, rpm0, rpm1: rpm1raw })) {
      return;
    }

    const croppedRpm = sm2CropToRpmWindow(rows, a, b, rpmMin, rpmMax);
    if (croppedRpm) {
      a = croppedRpm.a;
      b = croppedRpm.b;
    }
    if (b - a < 2) return;
    const gain = rows[b].rpm - rows[a].rpm;
    if (gain < 200) return;
    const n = b - a + 1;
    const dur = rows[b].t - rows[a].t;
    const rps = dur > 1e-6 ? gain / dur : 0;
    const ped = hasPedal ? sm2SegPedalStats(rows, a, b) : ped0;
    const pMax = ped ? ped.max : 0;
    candidates.push({
      a,
      b,
      dur,
      gain,
      score: n * 8 + Math.min(dur, 12) * Math.sqrt(Math.max(gain, 1)) + rps + pMax * 6,
    });
  };

  const considerRange = (from, to) => {
    if (to - from < 2) return;
    const rising = sm2AllRisingSegments(rows, from, to);
    const longest = sm2LongestRising(rows, from, to);
    const segs = rising.slice();
    if (longest && !segs.some((s) => s.a === longest.a && s.b === longest.b)) segs.push(longest);
    for (const seg of segs) considerSeg(seg);
  };

  const timeBursts = sm2TimeBursts(rows, gapSec);
  if (hasPedal) {
    for (const burst of timeBursts) {
      const info = sm2BurstLoadFloor(rows, burst.a, burst.b, pedalMinReq, pedalMax);
      if (!info || info.maxP < pedalMinReq - 0.5) continue;
      const runs = sm2CollectRuns(rows, burst.a, burst.b, (i) => {
        const v = rows[i].pedal;
        return sm2Ok(v) && v >= info.floor && v <= pedalMax + 1.5;
      });
      for (const run0 of runs) {
        const run = sm2TrimStompAndLift(rows, run0.a, run0.b, info.floor, info.maxP, info.plateau);
        if (run.b - run.a < 2) continue;
        const gears = sm2SplitByGearAndGap(rows, run.a, run.b, gapSec);
        for (const g of gears) considerRange(g.a, g.b);
      }
    }
  } else {
    for (const burst of timeBursts) {
      const gears = sm2SplitByGearAndGap(rows, burst.a, burst.b, gapSec);
      for (const g of gears) considerRange(g.a, g.b);
    }
  }

  candidates.sort((x, y) => y.score - x.score);
  const kept = [];
  for (const c of candidates) {
    const overlaps = kept.some((k) => !(c.b < k.a || c.a > k.b));
    if (!overlaps) kept.push(c);
  }
  kept.sort((a, b) => a.a - b.a);

  return kept.map((c) => ({
    a: c.a,
    b: c.b,
    rows: rows.slice(c.a, c.b + 1),
    fullThr: pedalMinReq,
    maxPedal,
    dur: c.dur,
    gain: c.gain,
    score: c.score,
    hasPedal,
  }));
}

/** Совместимость: один лучший WOT. */
function sm2FindBestWotPull(rows, opts = {}) {
  const all = sm2FindAllWotPulls(rows, opts);
  if (!all.length) return null;
  all.sort((a, b) => b.score - a.score);
  return all[0];
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

  const toc = sm2ParseToc(view, u8).filter((e) => e.size >= 512);
  let starts = sm2FindSessionStarts(u8, view);
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
    samples = sm2KeepMainTimeCluster(samples);
    if (samples.length < 5) continue;
    sm2SanitizeSpeed(samples);

    const rpmName = names.find((n) => sm2NameScore(n.name, SM2_RPM_KEYS) >= 40)?.name || "Обороты двигателя";
    const pedalName =
      names.find((n) => sm2NameScore(n.name, SM2_PEDAL_KEYS) >= 40)?.name ||
      names.find((n) => sm2NameScore(n.name, SM2_THROTTLE_KEYS) >= 40)?.name ||
      "Педаль/дроссель";

    const speedName = names.find((n) => sm2NameScore(n.name, SM2_SPEED_KEYS) >= 40)?.name || null;
    const hasSpeed = samples.some((r) => Number.isFinite(r.speed));
    const keepSpeedCol = !!(speedName || hasSpeed);
    const headers = keepSpeedCol
      ? ["Time", rpmName, pedalName, speedName || "Скорость"]
      : ["Time", rpmName, pedalName];
    const rows = samples.map((r) => (keepSpeedCol
      ? [r.t, r.rpm, r.pedal, Number.isFinite(r.speed) ? r.speed : NaN]
      : [r.t, r.rpm, r.pedal]));
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
        hasSpeed: keepSpeedCol,
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

/** Вырезать все WOT ≥ minDuration из сессии. */
function sm2SessionToWotPulls(session, opts) {
  const samples = session.samples || session.rows.map((r) => ({
    t: r[0], rpm: r[1], pedal: r[2], speed: r[3],
  }));
  const pulls = sm2FindAllWotPulls(samples, opts);
  if (!pulls.length) return [];
  // Обзор показывает канал скорости как в логе. Подделку VSS (застывшие ~86%)
  // отсекает sm2SanitizeSpeed только в точках расчёта (замок передачи / dyno).

  const keepSpeed = session.headers.length >= 4
    || session.meta?.hasSpeed
    || samples.some((r) => Number.isFinite(r.speed));
  const headers = keepSpeed && session.headers.length >= 4
    ? session.headers
    : keepSpeed
      ? [...session.headers.slice(0, 3), "Скорость"]
      : session.headers;

  return pulls.map((pull, idx) => {
    const t0 = pull.rows[0].t;
    const label = pulls.length > 1
      ? `${session.label} · #${idx + 1}`
      : session.label;
    return {
      headers,
      rows: pull.rows.map((r) => (keepSpeed
        ? [r.t - t0, r.rpm, r.pedal, Number.isFinite(r.speed) ? r.speed : NaN]
        : [r.t - t0, r.rpm, r.pedal])),
      absRows: pull.rows.map((r) => (keepSpeed
        ? [r.t, r.rpm, r.pedal, Number.isFinite(r.speed) ? r.speed : NaN]
        : [r.t, r.rpm, r.pedal])),
      label,
      meta: {
        ...session.meta,
        hasSpeed: keepSpeed,
        fullThr: pull.fullThr,
        maxPedal: pull.maxPedal,
        wotDuration: pull.dur,
        rpmGain: pull.gain,
        wotIndex: idx + 1,
        wotCount: pulls.length,
      },
    };
  });
}

/** Вырезать лучший WOT из сессии → rows [t,rpm,pedal] */
function sm2SessionToWotRows(session, opts) {
  const all = sm2SessionToWotPulls(session, opts);
  return all.length ? all[0] : null;
}
