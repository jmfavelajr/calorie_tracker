/**
 * BMI / TDEE + food lookup via /api/fdc
 * Meal estimates via /api/meal-estimate (Grok)
 * Speech-to-text via Web Speech API (fills query only)
 * Auth: Supabase Google OAuth
 * Logging + diary via food_logs
 */

const FDC_PROXY = '/api/fdc';
const ESTIMATE_URL = '/api/meal-estimate';
const CONFIG_URL = '/api/config';
const LOG_COOLDOWN_MS = 1500;

let html5QrCode = null;
let scanBusy = false;
let supabase = null;
let currentUser = null;
let lastFoodResult = null;
let logCooldownedUntil = 0;
let diaryViewDate = startOfLocalDay(new Date());
let speechRecognition = null;
let speechListening = false;

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function toDateInputValue(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateInputValue(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return startOfLocalDay(new Date());
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayBoundsIso(day) {
  const start = startOfLocalDay(day);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function calc() {
  const w = parseFloat(document.getElementById('weight').value) || 0;
  const h = parseFloat(document.getElementById('height').value) || 0;
  const age = parseFloat(document.getElementById('age').value) || 0;
  const sex = document.getElementById('sex').value;
  const act = parseFloat(document.getElementById('activity').value);

  if (w <= 0 || h <= 0) return;
  const bmi = w / Math.pow(h / 100, 2);
  let category = 'Normal';
  if (bmi < 18.5) category = 'Underweight';
  else if (bmi < 25) category = 'Normal';
  else if (bmi < 30) category = 'Overweight';
  else category = 'Obese';

  let bmr = sex === 'm' ? 10 * w + 6.25 * h - 5 * age + 5 : 10 * w + 6.25 * h - 5 * age - 161;
  const tdee = bmr * act;

  document.getElementById('result').innerHTML = `
    <div>BMI</div>
    <div class="big">${bmi.toFixed(1)} <span style="font-size:1rem;font-weight:500">(${category})</span></div>
    <div style="margin-top:14px">BMR (basal): ~${Math.round(bmr)} kcal/day</div>
    <div>TDEE (maintenance): ~${Math.round(tdee)} kcal/day</div>
    <div style="margin-top:8px;color:var(--muted);font-size:0.85rem">
      Mild deficit (−300): ${Math.round(tdee - 300)} · Aggressive (−500): ${Math.round(tdee - 500)}
    </div>
  `;
}

function showFoodResult(html, isError) {
  const el = document.getElementById('foodResult');
  el.hidden = false;
  el.classList.toggle('error', !!isError);
  const isCarousel = !isError && html && html.indexOf('result-carousel') !== -1;
  el.classList.toggle('loading-msg', !isError && !isCarousel);
  el.innerHTML = html;
  if (isCarousel) bindResultCarousel(el);
}

function bindResultCarousel(root) {
  const track = root.querySelector('.result-carousel');
  const dots = root.querySelectorAll('.carousel-dot');
  if (!track || !dots.length) return;

  const setActive = () => {
    const cards = track.querySelectorAll('.result-card');
    if (!cards.length) return;
    const left = track.scrollLeft;
    let best = 0;
    let bestDist = Infinity;
    cards.forEach((card, i) => {
      const dist = Math.abs(card.offsetLeft - left);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    dots.forEach((d, i) => d.classList.toggle('active', i === best));
  };

  track.addEventListener('scroll', () => {
    window.clearTimeout(track._dotT);
    track._dotT = window.setTimeout(setActive, 60);
  }, { passive: true });

  dots.forEach((dot, i) => {
    dot.addEventListener('click', () => {
      const card = track.querySelectorAll('.result-card')[i];
      if (card) track.scrollTo({ left: card.offsetLeft, behavior: 'smooth' });
    });
  });

  setActive();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

function sourceLabel(src) {
  if (src === 'usda') return 'USDA FoodData Central';
  if (src === 'calorieapi') return 'Calorie API';
  if (src === 'apininjas') return 'API Ninjas';
  if (src === 'grok_estimate') return 'AI meal estimate';
  return src || 'Unknown';
}

function looksLikeBarcode(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 14) return false;
  const compact = s.replace(/[\s-]/g, '');
  return digits.length >= compact.length * 0.9;
}

function setMicStatus(msg, isError) {
  const el = document.getElementById('micStatus');
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('error');
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

function setMicListeningUi(on) {
  const btn = document.getElementById('micBtn');
  if (!btn) return;
  speechListening = !!on;
  btn.classList.toggle('listening', !!on);
  btn.setAttribute('aria-label', on ? 'Stop voice input' : 'Start voice input');
  btn.title = on ? 'Listening — tap to stop' : 'Speak meal or food name';
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function stopSpeechRecognition() {
  if (speechRecognition) {
    try { speechRecognition.abort(); } catch (e) {
      try { speechRecognition.stop(); } catch (e2) {}
    }
  }
  setMicListeningUi(false);
}

function toggleSpeechInput() {
  const Ctor = getSpeechRecognitionCtor();
  const btn = document.getElementById('micBtn');
  if (!Ctor) {
    setMicStatus('Voice input not supported in this browser. Type instead (Chrome works best).', true);
    if (btn) btn.disabled = true;
    return;
  }

  if (speechListening) {
    stopSpeechRecognition();
    setMicStatus('Stopped.');
    return;
  }

  if (!speechRecognition) {
    speechRecognition = new Ctor();
    speechRecognition.continuous = false;
    speechRecognition.interimResults = true;
    speechRecognition.maxAlternatives = 1;
    speechRecognition.lang = (navigator.language || 'en-US');

    speechRecognition.onstart = () => {
      setMicListeningUi(true);
      setMicStatus('Listening… tap mic to stop');
    };

    speechRecognition.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += piece;
        else interim += piece;
      }
      const input = document.getElementById('foodQuery');
      if (!input) return;
      if (finalText) {
        input.value = finalText.trim();
        setMicStatus('Got it — edit if needed, then Look up or Estimate meal.');
        try { speechRecognition.abort(); } catch (e) {}
      } else if (interim) {
        input.value = interim.trim();
        setMicStatus('Listening…');
      }
    };

    speechRecognition.onerror = (event) => {
      setMicListeningUi(false);
      const err = event && event.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        setMicStatus('Microphone permission denied. Allow mic access or type instead.', true);
      } else if (err === 'no-speech') {
        setMicStatus('No speech detected. Try again.');
      } else if (err === 'aborted') {
        setMicStatus('');
      } else {
        setMicStatus('Voice error: ' + (err || 'unknown') + '. Try typing instead.', true);
      }
    };

    speechRecognition.onend = () => {
      setMicListeningUi(false);
    };
  }

  try {
    speechRecognition.start();
  } catch (e) {
    setMicListeningUi(false);
    setMicStatus('Could not start microphone. Try again or type instead.', true);
  }
}

function initSpeechUi() {
  const btn = document.getElementById('micBtn');
  if (!btn) return;
  if (!getSpeechRecognitionCtor()) {
    btn.disabled = true;
    btn.title = 'Voice not supported in this browser';
    setMicStatus('Voice input not available here — type your meal instead.', false);
    return;
  }
  btn.addEventListener('click', () => toggleSpeechInput());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopSpeechRecognition();
  });
}

function fmtMacro(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  return Math.round(Number(v));
}

function renderFoodCard(food, extrasHtml) {
  const isEstimate = food.source === 'grok_estimate';
  const brandLine = [food.brand, food.category].filter(Boolean).join(' · ');
  const badge = isEstimate
    ? `<span class="estimate-badge">Estimate${food.confidence ? ' · ' + escapeHtml(food.confidence) : ''}</span>`
    : '';

  let calBlock = '';
  if (food.servingKcal != null) {
    calBlock += `<div class="big">${food.servingKcal} <span class="unit">kcal</span></div>`;
    if (food.servingLabel) {
      calBlock += `<div class="serving-cal">${isEstimate ? 'estimated per' : 'per serving'} (${escapeHtml(food.servingLabel)})</div>`;
    }
  } else if (food.kcalPer100 != null) {
    calBlock += `<div class="big">${food.kcalPer100} <span class="unit">kcal / 100 g</span></div>`;
  } else {
    calBlock = `<div class="muted">Calorie data not listed.</div>`;
  }

  if (food.kcalPer100 != null && food.servingKcal != null) {
    calBlock += `<div class="food-meta" style="margin-top:6px">Also ${food.kcalPer100} kcal / 100 g</div>`;
  }
  if (isEstimate && food.kcalLow != null && food.kcalHigh != null) {
    calBlock += `<div class="food-meta estimate-range">Typical range: ${food.kcalLow}–${food.kcalHigh} kcal</div>`;
  }

  let includesHtml = '';
  if (isEstimate && Array.isArray(food.includes) && food.includes.length) {
    includesHtml =
      `<div class="includes-block">` +
      `<div class="includes-label">Counted in this estimate</div>` +
      `<ul class="estimate-includes">` +
      food.includes.map((a) => `<li>${escapeHtml(a)}</li>`).join('') +
      `</ul></div>`;
  }

  let assumptionsHtml = '';
  if (isEstimate && Array.isArray(food.assumptions) && food.assumptions.length) {
    assumptionsHtml =
      `<div class="includes-label" style="margin-top:12px">Assumptions</div>` +
      `<ul class="estimate-assumptions">` +
      food.assumptions.map((a) => `<li>${escapeHtml(a)}</li>`).join('') +
      `</ul>`;
  }

  const notesHtml =
    isEstimate && food.notes
      ? `<div class="food-meta" style="margin-top:8px">${escapeHtml(food.notes)}</div>`
      : '';

  const confirmHint = isEstimate
    ? `<div class="estimate-confirm">Check the list above. Missing a side? Log it as a separate entry.</div>`
    : '';

  const link = food.link
    ? `<div class="food-source">Source: <a href="${escapeHtml(food.link)}" target="_blank" rel="noopener">${escapeHtml(sourceLabel(food.source))}</a></div>`
    : `<div class="food-source">Source: ${escapeHtml(sourceLabel(food.source))}${isEstimate ? ' (not lab data)' : ''}</div>`;

  const nameBlock = `
    <div class="food-name">${escapeHtml(food.name || 'Unknown')} ${badge}</div>
    ${brandLine ? `<div class="food-meta">${escapeHtml(brandLine)}</div>` : ''}
    ${food.packageWeight ? `<div class="food-meta">Package: ${escapeHtml(food.packageWeight)}</div>` : ''}
    ${food.barcode ? `<div class="food-meta">UPC: ${escapeHtml(food.barcode)}</div>` : ''}
  `;

  const overviewCard = `
    <div class="result-card" data-card="0">
      <div class="card-kicker">Overview</div>
      ${nameBlock}
      <div class="cal-block">${calBlock}</div>
      ${includesHtml}
      ${assumptionsHtml}
      ${confirmHint}
      ${notesHtml}
      ${link}
      ${extrasHtml || ''}
    </div>
  `;

  const p = fmtMacro(food.protein_g);
  const c = fmtMacro(food.carbs_g);
  const f = fmtMacro(food.fat_g);
  const hasMacros = p != null || c != null || f != null;

  let macroBody;
  if (hasMacros) {
    macroBody = `
      <div class="macro-grid">
        <div class="macro-cell"><div class="macro-val">${p != null ? p + 'g' : '—'}</div><div class="macro-label">Protein</div></div>
        <div class="macro-cell"><div class="macro-val">${c != null ? c + 'g' : '—'}</div><div class="macro-label">Carbs</div></div>
        <div class="macro-cell"><div class="macro-val">${f != null ? f + 'g' : '—'}</div><div class="macro-label">Fat</div></div>
      </div>
    `;
  } else {
    macroBody = `<div class="macro-empty">Macro details not available for this item.</div>`;
  }

  let kcalAnchor = '';
  if (food.servingKcal != null) {
    kcalAnchor = `<div class="cal-block"><div class="big">${food.servingKcal} <span class="unit">kcal</span></div></div>`;
  } else if (food.kcalPer100 != null) {
    kcalAnchor = `<div class="cal-block"><div class="big">${food.kcalPer100} <span class="unit">kcal / 100 g</span></div></div>`;
  }

  const macrosCard = `
    <div class="result-card" data-card="1">
      <div class="card-kicker">Macros</div>
      <div class="food-name">${escapeHtml(food.name || 'Unknown')}</div>
      ${brandLine ? `<div class="food-meta">${escapeHtml(brandLine)}</div>` : ''}
      ${kcalAnchor}
      ${macroBody}
      <div class="food-source">Swipe back for what was counted</div>
    </div>
  `;

  return `
    <div class="result-carousel-wrap">
      <div class="result-carousel" id="resultCarousel">
        ${overviewCard}
        ${macrosCard}
      </div>
      <div class="carousel-dots" role="tablist" aria-label="Result cards">
        <button type="button" class="carousel-dot active" aria-label="Overview"></button>
        <button type="button" class="carousel-dot" aria-label="Macros"></button>
      </div>
      <div class="carousel-hint">Swipe for macros →</div>
    </div>
  `;
}

function baseKcalForLog(food) {
  if (!food) return null;
  if (food.servingKcal != null && !Number.isNaN(Number(food.servingKcal))) {
    return { kcal: Number(food.servingKcal), basis: 'serving' };
  }
  if (food.kcalPer100 != null && !Number.isNaN(Number(food.kcalPer100))) {
    return { kcal: Number(food.kcalPer100), basis: 'per_100g' };
  }
  return null;
}

function formatLogTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

function syncDiaryChrome() {
  const title = document.getElementById('diaryTitle');
  const dateInput = document.getElementById('diaryDate');
  const nextBtn = document.getElementById('diaryNext');
  const today = startOfLocalDay(new Date());

  if (dateInput) dateInput.value = toDateInputValue(diaryViewDate);
  if (title) {
    title.textContent = isSameLocalDay(diaryViewDate, today)
      ? 'Today'
      : diaryViewDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  if (nextBtn) {
    nextBtn.disabled = isSameLocalDay(diaryViewDate, today) || diaryViewDate > today;
  }
}

function clearDiaryUi() {
  const section = document.getElementById('diarySection');
  const list = document.getElementById('diaryList');
  const total = document.getElementById('diaryTotal');
  const sub = document.getElementById('diarySub');
  if (section) section.hidden = true;
  if (list) list.innerHTML = '';
  if (total) total.textContent = '0 kcal';
  if (sub) sub.textContent = 'Sign in to see your food log.';
}

function renderDiary(rows) {
  const section = document.getElementById('diarySection');
  const list = document.getElementById('diaryList');
  const totalEl = document.getElementById('diaryTotal');
  const sub = document.getElementById('diarySub');
  if (!section || !list) return;

  section.hidden = false;
  syncDiaryChrome();

  const items = rows || [];
  let sum = 0;
  items.forEach((r) => { sum += Number(r.kcal_logged) || 0; });
  totalEl.textContent = Math.round(sum) + ' kcal';

  if (!items.length) {
    sub.textContent = 'No foods logged for this day.';
    list.innerHTML = '';
    return;
  }

  sub.textContent = items.length + (items.length === 1 ? ' item' : ' items');
  list.innerHTML = items.map((r) => {
    const qty = r.quantity != null ? r.quantity : 1;
    const label = r.serving_label ? ` · ${escapeHtml(String(r.serving_label))}` : '';
    const time = formatLogTime(r.created_at);
    return `
      <li class="diary-item" data-id="${r.id}">
        <div class="diary-item-main">
          <div class="diary-item-name">${escapeHtml(r.name || 'Food')}</div>
          <div class="diary-item-meta">${escapeHtml(String(qty))}×${label}${time ? ' · ' + escapeHtml(time) : ''}</div>
        </div>
        <div class="diary-item-actions">
          <div class="diary-item-kcal">${Math.round(Number(r.kcal_logged) || 0)}</div>
          <button type="button" class="btn-delete" data-delete-id="${r.id}">Remove</button>
        </div>
      </li>`;
  }).join('');

  list.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', () => deleteLogEntry(btn.getAttribute('data-delete-id')));
  });
}

async function loadDiary() {
  const section = document.getElementById('diarySection');
  if (!currentUser || !supabase) {
    clearDiaryUi();
    return;
  }

  section.hidden = false;
  syncDiaryChrome();
  document.getElementById('diarySub').textContent = 'Loading…';

  const { start, end } = dayBoundsIso(diaryViewDate);
  try {
    const { data, error } = await supabase
      .from('food_logs')
      .select('id, name, quantity, serving_label, kcal_logged, created_at')
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: false });

    if (error) throw error;
    renderDiary(data || []);
  } catch (err) {
    document.getElementById('diarySub').textContent =
      (err && err.message) ? err.message : 'Could not load log.';
    document.getElementById('diaryList').innerHTML = '';
    document.getElementById('diaryTotal').textContent = '—';
  }
}

function shiftDiaryDay(delta) {
  const next = new Date(diaryViewDate.getFullYear(), diaryViewDate.getMonth(), diaryViewDate.getDate() + delta);
  const today = startOfLocalDay(new Date());
  if (next > today) return;
  diaryViewDate = next;
  loadDiary();
}

function goDiaryToday() {
  diaryViewDate = startOfLocalDay(new Date());
  loadDiary();
}

async function deleteLogEntry(id) {
  if (!supabase || !currentUser || !id) return;
  try {
    const { error } = await supabase.from('food_logs').delete().eq('id', id);
    if (error) throw error;
    await loadDiary();
  } catch (err) {
    const sub = document.getElementById('diarySub');
    if (sub) sub.textContent = (err && err.message) || 'Delete failed';
  }
}

function updateLogControls() {
  const panel = document.getElementById('logPanel');
  const btn = document.getElementById('logCaloriesBtn');
  const hint = document.getElementById('logHint');
  if (!panel || !btn) return;

  const hasResult = !!lastFoodResult && !lastFoodResult._isError;
  const kcalInfo = hasResult ? baseKcalForLog(lastFoodResult) : null;
  const signedIn = !!currentUser;

  panel.hidden = !hasResult;

  if (!hasResult) {
    btn.disabled = true;
    return;
  }

  if (!signedIn) {
    btn.disabled = true;
    hint.textContent = 'Sign in with Google to log this food.';
    return;
  }

  if (!kcalInfo) {
    btn.disabled = true;
    hint.textContent = 'No calorie value available to log for this item.';
    return;
  }

  if (Date.now() < logCooldownedUntil) {
    btn.disabled = true;
    hint.textContent = 'Quantity multiplies kcal per serving.';
    return;
  }

  btn.disabled = false;
  if (lastFoodResult && lastFoodResult.source === 'grok_estimate') {
    hint.textContent =
      'Confirm what was counted above. Missing a side? Log it separately. Quantity multiplies primary kcal.';
  } else if (kcalInfo.basis === 'per_100g') {
    hint.textContent = 'Quantity multiplies kcal per 100 g (default 1 = 100 g).';
  } else {
    hint.textContent = 'Quantity multiplies kcal per serving.';
  }
}

function showLogSuccess(msg) {
  const el = document.getElementById('logSuccess');
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(showLogSuccess._t);
  showLogSuccess._t = setTimeout(() => { el.hidden = true; }, 4000);
}

async function logCalories() {
  const btn = document.getElementById('logCaloriesBtn');
  const qtyInput = document.getElementById('logQty');

  if (!currentUser || !supabase) {
    updateLogControls();
    return;
  }
  if (!lastFoodResult || lastFoodResult._isError) return;

  const kcalInfo = baseKcalForLog(lastFoodResult);
  if (!kcalInfo) return;

  let qty = parseFloat(qtyInput.value);
  if (!Number.isFinite(qty) || qty <= 0) qty = 1;
  qtyInput.value = String(qty);

  const kcalLogged = Math.round(kcalInfo.kcal * qty);
  const food = lastFoodResult;

  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = 'Logging…';

  const row = {
    user_id: currentUser.id,
    name: food.name || 'Unknown',
    brand: food.brand || null,
    category: food.category || null,
    barcode: food.barcode || null,
    source: food.source || null,
    serving_label: food.servingLabel || (kcalInfo.basis === 'per_100g' ? '100 g' : null),
    kcal_per_serving: food.servingKcal != null ? Number(food.servingKcal) : null,
    kcal_per_100: food.kcalPer100 != null ? Number(food.kcalPer100) : null,
    quantity: qty,
    kcal_logged: kcalLogged,
    protein_g: food.protein_g != null ? Number(food.protein_g) : null,
    carbs_g: food.carbs_g != null ? Number(food.carbs_g) : null,
    fat_g: food.fat_g != null ? Number(food.fat_g) : null,
  };

  try {
    const { error } = await supabase.from('food_logs').insert(row);
    if (error) throw error;

    showLogSuccess(`Logged ${kcalLogged} kcal · ${food.name || 'item'}`);
    logCooldownedUntil = Date.now() + LOG_COOLDOWN_MS;
    setTimeout(updateLogControls, LOG_COOLDOWN_MS + 50);
    diaryViewDate = startOfLocalDay(new Date());
    await loadDiary();
  } catch (err) {
    const msg = err && err.message ? err.message : 'Log failed';
    const success = document.getElementById('logSuccess');
    if (success) {
      success.hidden = false;
      success.style.color = 'var(--danger)';
      success.style.borderColor = 'rgba(255,107,107,0.35)';
      success.style.background = 'rgba(255,107,107,0.12)';
      success.textContent = msg;
      setTimeout(() => {
        success.hidden = true;
        success.style.color = '';
        success.style.borderColor = '';
        success.style.background = '';
      }, 5000);
    }
  } finally {
    btn.textContent = prevLabel;
    updateLogControls();
  }
}

async function estimateMeal(forcedValue) {
  stopSpeechRecognition();
  const input = document.getElementById('foodQuery');
  const raw = forcedValue != null ? String(forcedValue) : (input.value || '').trim();
  if (!raw) {
    lastFoodResult = null;
    showFoodResult('Describe a meal (e.g. eggs benedict with hash browns at IHOP).', true);
    updateLogControls();
    return;
  }

  input.value = raw;

  const btn = document.getElementById('estimateBtn');
  const lookupBtn = document.getElementById('lookupBtn');
  btn.disabled = true;
  lookupBtn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Estimating…';
  lastFoodResult = null;
  updateLogControls();
  document.getElementById('logSuccess').hidden = true;
  showFoodResult('Estimating meal calories…', false);

  try {
    const res = await fetch(ESTIMATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phrase: raw }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `Estimate failed (${res.status})`);
    }

    const results = data.results || [];
    if (!results.length) {
      lastFoodResult = { _isError: true };
      showFoodResult('No estimate returned for that phrase.', true);
      updateLogControls();
      return;
    }

    lastFoodResult = results[0];
    showFoodResult(renderFoodCard(results[0]), false);
    updateLogControls();
  } catch (err) {
    lastFoodResult = { _isError: true };
    showFoodResult(escapeHtml(err.message || 'Estimate failed.'), true);
    updateLogControls();
  } finally {
    btn.disabled = false;
    lookupBtn.disabled = false;
    btn.textContent = prev;
  }
}

async function lookupFood(forcedValue) {
  stopSpeechRecognition();
  const input = document.getElementById('foodQuery');
  const raw = forcedValue != null ? String(forcedValue) : (input.value || '').trim();
  if (!raw) {
    lastFoodResult = null;
    showFoodResult('Enter a barcode or a food name.', true);
    updateLogControls();
    return;
  }

  input.value = raw;

  const btn = document.getElementById('lookupBtn');
  const estimateBtn = document.getElementById('estimateBtn');
  btn.disabled = true;
  if (estimateBtn) estimateBtn.disabled = true;
  btn.textContent = 'Looking up…';
  lastFoodResult = null;
  updateLogControls();
  document.getElementById('logSuccess').hidden = true;

  const isBarcode = looksLikeBarcode(raw);
  showFoodResult(
    isBarcode ? 'Searching USDA → Calorie API…' : 'Searching API Ninjas → Calorie API…',
    false
  );

  try {
    const url = isBarcode
      ? `${FDC_PROXY}?barcode=${encodeURIComponent(raw.replace(/\D/g, ''))}`
      : `${FDC_PROXY}?query=${encodeURIComponent(raw)}`;

    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (data.error) throw new Error(data.error);
      throw new Error(`Lookup failed (${res.status})`);
    }

    const results = data.results || [];
    if (!results.length) {
      const tried = (data.sourcesTried || []).join(', ') || 'configured sources';
      const notes = data.notes && data.notes.length
        ? `<div class="food-meta" style="margin-top:8px">${escapeHtml(data.notes.join(' · '))}</div>`
        : '';
      lastFoodResult = { _isError: true };
      showFoodResult(
        `No database results for <strong>${escapeHtml(raw)}</strong>.` +
        `<div class="food-meta">Tried: ${escapeHtml(tried)}</div>${notes}` +
        `<div class="food-meta" style="margin-top:10px">Try <strong>Estimate meal</strong> for restaurant or homemade dishes.</div>`,
        true
      );
      updateLogControls();
      return;
    }

    lastFoodResult = results[0];
    let extras = '';
    if (results.length > 1) {
      extras = `<div class="food-meta" style="margin-top:12px">Other matches:</div><ul style="margin:6px 0 0 18px;color:var(--muted);font-size:0.85rem">`;
      results.slice(1, 4).forEach((r) => {
        const kcal = r.servingKcal != null ? `${r.servingKcal} kcal` : (r.kcalPer100 != null ? `${r.kcalPer100} kcal/100g` : '');
        extras += `<li>${escapeHtml(r.name || '')}${kcal ? ' — ' + kcal : ''} <span>(${escapeHtml(sourceLabel(r.source))})</span></li>`;
      });
      extras += `</ul>`;
    }
    showFoodResult(renderFoodCard(results[0], extras), false);
    updateLogControls();
  } catch (err) {
    lastFoodResult = { _isError: true };
    showFoodResult(escapeHtml(err.message || 'Lookup failed.'), true);
    updateLogControls();
  } finally {
    btn.disabled = false;
    if (estimateBtn) estimateBtn.disabled = false;
    btn.textContent = 'Look up';
  }
}

async function startScanner() {
  if (typeof Html5Qrcode === 'undefined') {
    showFoodResult('Barcode scanner library failed to load. Check your connection and refresh.', true);
    return;
  }

  const wrap = document.getElementById('scannerWrap');
  const scanBtn = document.getElementById('scanBtn');
  const stopBtn = document.getElementById('stopScanBtn');

  wrap.hidden = false;
  scanBtn.hidden = true;
  stopBtn.hidden = false;
  scanBusy = false;

  if (!html5QrCode) html5QrCode = new Html5Qrcode('reader');

  const config = {
    fps: 10,
    qrbox: { width: 280, height: 140 },
    aspectRatio: 1.5,
    formatsToSupport: [
      Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.CODE_128
    ]
  };

  try {
    await html5QrCode.start(
      { facingMode: 'environment' },
      config,
      async (decodedText) => {
        if (scanBusy) return;
        scanBusy = true;
        const code = String(decodedText).replace(/\D/g, '');
        if (code.length < 6) {
          scanBusy = false;
          return;
        }
        try { await stopScanner(); } catch (e) {}
        document.getElementById('foodQuery').value = code;
        await lookupFood(code);
      },
      () => {}
    );
  } catch (err) {
    wrap.hidden = true;
    scanBtn.hidden = false;
    stopBtn.hidden = true;
    const msg = String(err && err.message ? err.message : err);
    if (/NotAllowedError|Permission/i.test(msg)) {
      showFoodResult('Camera permission denied. Allow camera access or enter the barcode manually.', true);
    } else if (/NotFoundError|DevicesNotFound/i.test(msg)) {
      showFoodResult('No camera found on this device.', true);
    } else {
      showFoodResult('Could not start camera: ' + escapeHtml(msg), true);
    }
  }
}

async function stopScanner() {
  const wrap = document.getElementById('scannerWrap');
  const scanBtn = document.getElementById('scanBtn');
  const stopBtn = document.getElementById('stopScanBtn');

  if (html5QrCode) {
    try {
      const state = html5QrCode.getState && html5QrCode.getState();
      if (state === 2 || state === undefined) await html5QrCode.stop();
      await html5QrCode.clear();
    } catch (e) {}
  }

  wrap.hidden = true;
  scanBtn.hidden = false;
  stopBtn.hidden = true;
  scanBusy = false;
}

function setAuthStatus(msg, isError) {
  const el = document.getElementById('authStatus');
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('error');
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

function renderAuthUi(user) {
  const signedOut = document.getElementById('authSignedOut');
  const signedIn = document.getElementById('authSignedIn');
  const nameEl = document.getElementById('authName');
  const emailEl = document.getElementById('authEmail');
  const avatar = document.getElementById('authAvatar');

  currentUser = user || null;

  if (!user) {
    signedOut.hidden = false;
    signedIn.hidden = true;
    avatar.hidden = true;
    avatar.removeAttribute('src');
    updateLogControls();
    clearDiaryUi();
    return;
  }

  signedOut.hidden = true;
  signedIn.hidden = false;

  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || user.email || 'Signed in';
  nameEl.textContent = name;
  emailEl.textContent = user.email || '';

  if (meta.avatar_url) {
    avatar.src = meta.avatar_url;
    avatar.hidden = false;
  } else {
    avatar.hidden = true;
  }
  updateLogControls();
  diaryViewDate = startOfLocalDay(new Date());
  loadDiary();
}

async function initAuth() {
  const btn = document.getElementById('googleSignInBtn');
  const signOutBtn = document.getElementById('signOutBtn');

  if (typeof window.supabase === 'undefined') {
    setAuthStatus('Auth library failed to load. Refresh and try again.', true);
    btn.disabled = true;
    return;
  }

  let cfg;
  try {
    const res = await fetch(CONFIG_URL);
    cfg = await res.json();
  } catch (e) {
    setAuthStatus('Could not load auth config.', true);
    btn.disabled = true;
    return;
  }

  if (!cfg.authConfigured || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    setAuthStatus('Auth not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY on Cloudflare Pages, then redeploy.', true);
    btn.disabled = true;
    return;
  }

  const createClient = window.supabase.createClient;
  if (!createClient) {
    setAuthStatus('Supabase client missing.', true);
    btn.disabled = true;
    return;
  }

  supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    renderAuthUi(sessionData.session && sessionData.session.user);
  } catch (e) {
    renderAuthUi(null);
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    renderAuthUi(session && session.user);
  });

  btn.addEventListener('click', async () => {
    setAuthStatus('');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Redirecting…';
    try {
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          queryParams: { prompt: 'select_account' },
        },
      });
      if (error) throw error;
    } catch (err) {
      setAuthStatus(err.message || 'Sign-in failed.', true);
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  signOutBtn.addEventListener('click', async () => {
    setAuthStatus('');
    try {
      await supabase.auth.signOut();
      renderAuthUi(null);
    } catch (err) {
      setAuthStatus(err.message || 'Sign-out failed.', true);
    }
  });
}

calc();

(function initFoodLookup() {
  document.getElementById('lookupBtn').addEventListener('click', () => lookupFood());
  document.getElementById('estimateBtn').addEventListener('click', () => estimateMeal());
  document.getElementById('scanBtn').addEventListener('click', startScanner);
  document.getElementById('stopScanBtn').addEventListener('click', () => stopScanner());
  document.getElementById('foodQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      lookupFood();
    }
  });
  document.getElementById('logCaloriesBtn').addEventListener('click', () => logCalories());
  document.getElementById('logQty').addEventListener('input', updateLogControls);

  document.getElementById('diaryPrev').addEventListener('click', () => shiftDiaryDay(-1));
  document.getElementById('diaryNext').addEventListener('click', () => shiftDiaryDay(1));
  document.getElementById('diaryTodayBtn').addEventListener('click', () => goDiaryToday());
  document.getElementById('diaryDate').addEventListener('change', (e) => {
    diaryViewDate = parseDateInputValue(e.target.value);
    const today = startOfLocalDay(new Date());
    if (diaryViewDate > today) diaryViewDate = today;
    loadDiary();
  });

  initSpeechUi();
  updateLogControls();
})();

initAuth();
