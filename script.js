/**
 * Calories — daily log UI
 * Food lookup via /api/fdc
 * Meal estimates via /api/meal-estimate (Grok)
 * Speech-to-text via Web Speech API
 * Auth: Supabase Google OAuth
 * Logging + diary via food_logs
 */

const FDC_PROXY = '/api/fdc';
const ESTIMATE_URL = '/api/meal-estimate';
const CONFIG_URL = '/api/config';
const LOG_COOLDOWN_MS = 1500;
const TARGET_DEFICIT_KEY = 'calories_target_deficit_kcal';
const TARGET_TDEE_KEY = 'calories_target_tdee_kcal';
const BMI_INPUTS_KEY = 'calories_bmi_inputs';

let html5QrCode = null;
let scanBusy = false;
let supabase = null;
let currentUser = null;
let lastFoodResult = null;
let logCooldownedUntil = 0;
let diaryViewDate = startOfLocalDay(new Date());
let speechRecognition = null;
let speechListening = false;
let diaryLoadError = false;
let diaryLoading = false;
let lastDiaryRows = [];
let bodyEstimateExpanded = true;

const RING_C = 2 * Math.PI * 78; // ~490.088
const STICKY_C = 2 * Math.PI * 12; // ~75.4
let ringHasPainted = false;
let stickyObserver = null;
let toastTimer = null;
let selectedMethod = 'lookup'; // scan | lookup | estimate

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function setRingProgress(circle, circumference, pct, over, animateMs) {
  if (!circle) return;
  const clamped = Math.max(0, Math.min(100, pct));
  const offset = circumference * (1 - clamped / 100);
  const reduce = prefersReducedMotion();
  if (reduce) {
    circle.style.transition = 'none';
  } else if (animateMs != null) {
    circle.style.transition = `stroke-dashoffset ${animateMs}ms ease-out, stroke 200ms ease-out`;
  }
  circle.style.strokeDasharray = String(circumference);
  circle.style.strokeDashoffset = String(offset);
  circle.classList.toggle('over', !!over);
}

function showToast(title, meta, status) {
  const toast = document.getElementById('resultToast');
  const dot = document.getElementById('toastDot');
  const titleEl = document.getElementById('toastTitle');
  const metaEl = document.getElementById('toastMeta');
  if (!toast || !titleEl) return;
  clearTimeout(toastTimer);
  toast.hidden = false;
  toast.classList.remove('hiding');
  titleEl.textContent = title || '';
  if (metaEl) {
    if (meta) {
      metaEl.hidden = false;
      metaEl.textContent = meta;
    } else {
      metaEl.hidden = true;
      metaEl.textContent = '';
    }
  }
  if (dot) {
    dot.className = 'toast-dot ' + (status === 'caution' ? 'caution' : status === 'danger' ? 'danger' : 'success');
  }
  // force reflow for animation
  void toast.offsetWidth;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => {
    toast.classList.add('hiding');
    toast.classList.remove('visible');
    setTimeout(() => {
      toast.hidden = true;
      toast.classList.remove('hiding');
    }, prefersReducedMotion() ? 0 : 160);
  }, 2400);
}

function emptyPlateSvg(withLeaf) {
  const leaf = withLeaf
    ? `<path d="M28 18c2-4 7-5 9-4-1 4-4 7-8 8"/><path d="M29 20c1.5-2 4-3 5.5-2.5"/>`
    : '';
  return `<div class="empty-state">
    <div class="empty-state-mark" aria-hidden="true">
      <div class="plate-bg">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#6ECF97" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <ellipse cx="24" cy="28" rx="16" ry="8"/>
          <ellipse cx="24" cy="26" rx="10" ry="5"/>
          ${leaf}
        </svg>
      </div>
    </div>
    <p class="empty-state-title">${withLeaf ? 'Nothing logged yet' : 'No foods found'}</p>
    <p class="empty-state-copy">${withLeaf ? 'Add a food above to start today’s log.' : 'Try another name, scan a barcode, or estimate the meal.'}</p>
  </div>`;
}

function setMethodChip(method) {
  selectedMethod = method;
  const map = {
    scan: 'methodChipScan',
    lookup: 'methodChipLookup',
    estimate: 'methodChipEstimate',
  };
  Object.keys(map).forEach((key) => {
    const el = document.getElementById(map[key]);
    if (!el) return;
    const on = key === method;
    el.classList.toggle('selected', on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function updateStickyVisibility(show) {
  const sticky = document.getElementById('stickyToday');
  if (!sticky) return;
  if (!currentUser) {
    sticky.hidden = true;
    sticky.classList.remove('visible');
    sticky.setAttribute('aria-hidden', 'true');
    return;
  }
  if (show) {
    sticky.hidden = false;
    sticky.setAttribute('aria-hidden', 'false');
    void sticky.offsetWidth;
    sticky.classList.add('visible');
  } else {
    sticky.classList.remove('visible');
    sticky.setAttribute('aria-hidden', 'true');
    // keep in DOM for transition; hide after
    setTimeout(() => {
      if (!sticky.classList.contains('visible')) sticky.hidden = true;
    }, prefersReducedMotion() ? 0 : 180);
  }
}

function initStickyObserver() {
  const hero = document.getElementById('todaySection');
  const sticky = document.getElementById('stickyToday');
  if (!hero || !sticky || stickyObserver) return;
  stickyObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!currentUser || hero.hidden) {
        updateStickyVisibility(false);
        return;
      }
      updateStickyVisibility(!(entry && entry.isIntersecting));
    },
    { threshold: 0, rootMargin: '0px' }
  );
  stickyObserver.observe(hero);

  const addBtn = document.getElementById('stickyAddBtn');
  const inner = document.getElementById('stickyInner');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const section = document.getElementById('addFoodSection');
      if (section) section.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });
  }
  if (inner && !inner.dataset.bound) {
    inner.dataset.bound = '1';
    const goHero = () => {
      const section = document.getElementById('todaySection');
      if (section) section.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    };
    inner.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'stickyAddBtn') return;
      goHero();
    });
    inner.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        goHero();
      }
    });
  }
}



const REGION_ORDER_SIGNED_OUT = [
  'auth-google',
  'diary-gate',
  'body-estimate',
  'add-food',
];

const REGION_ORDER_SIGNED_IN = [
  'today',
  'add-food',
  'diary-list',
  'body-estimate',
  'auth-signout',
];

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatKcal(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

function getStoredTargets() {
  const deficit = parseInt(localStorage.getItem(TARGET_DEFICIT_KEY) || '', 10);
  const tdee = parseInt(localStorage.getItem(TARGET_TDEE_KEY) || '', 10);
  return {
    deficit: Number.isFinite(deficit) && deficit > 0 ? deficit : null,
    tdee: Number.isFinite(tdee) && tdee > 0 ? tdee : null,
  };
}

function getActiveTarget() {
  const t = getStoredTargets();
  if (t.deficit) return { kcal: t.deficit, kind: 'deficit' };
  if (t.tdee) return { kcal: t.tdee, kind: 'tdee' };
  return null;
}

function saveTargets(tdee, deficit) {
  if (Number.isFinite(tdee) && tdee > 0) localStorage.setItem(TARGET_TDEE_KEY, String(Math.round(tdee)));
  if (Number.isFinite(deficit) && deficit > 0) localStorage.setItem(TARGET_DEFICIT_KEY, String(Math.round(deficit)));
}

function saveBmiInputs() {
  try {
    localStorage.setItem(BMI_INPUTS_KEY, JSON.stringify({
      weight: document.getElementById('weight').value,
      height: document.getElementById('height').value,
      age: document.getElementById('age').value,
      sex: document.getElementById('sex').value,
      activity: document.getElementById('activity').value,
    }));
  } catch (e) {}
}

function restoreBmiInputs() {
  try {
    const raw = localStorage.getItem(BMI_INPUTS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    ['weight', 'height', 'age', 'sex', 'activity'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && data[id] != null) el.value = data[id];
    });
  } catch (e) {}
}

function reorderRegions(signedIn) {
  const stack = document.getElementById('appStack');
  if (!stack) return;
  const order = signedIn ? REGION_ORDER_SIGNED_IN : REGION_ORDER_SIGNED_OUT;
  order.forEach((name) => {
    const el = stack.querySelector(`[data-region="${name}"]`);
    if (el) stack.appendChild(el);
  });
}

function setExclusiveAuth(signedIn) {
  const googleSection = document.getElementById('authGoogleSection');
  const signOutSection = document.getElementById('authSignOutSection');
  const googleBtn = document.getElementById('googleSignInBtn');
  const signOutBtn = document.getElementById('signOutBtn');

  if (signedIn) {
    if (googleBtn) googleBtn.remove();
    if (googleSection) googleSection.hidden = true;
    if (signOutSection) {
      signOutSection.hidden = false;
      if (!document.getElementById('signOutBtn')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'signOutBtn';
        btn.className = 'btn btn-secondary btn-auth';
        btn.textContent = 'Sign out';
        signOutSection.insertBefore(btn, signOutSection.firstChild);
        bindSignOut(btn);
      }
    }
  } else {
    if (signOutBtn) signOutBtn.remove();
    if (signOutSection) signOutSection.hidden = true;
    if (googleSection) {
      googleSection.hidden = false;
      if (!document.getElementById('googleSignInBtn')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'googleSignInBtn';
        btn.className = 'btn btn-accent btn-auth';
        btn.innerHTML = '<span class="google-g" aria-hidden="true">G</span> Continue with Google';
        googleSection.insertBefore(btn, googleSection.firstChild);
        bindGoogleSignIn(btn);
      }
    }
  }
}

function syncBodyEstimateDisclosure(forceExpand) {
  const hasTarget = !!getActiveTarget();
  const panel = document.getElementById('bodyEstimatePanel');
  const toggle = document.getElementById('bodyEstimateToggle');
  const summary = document.getElementById('bodyEstimateSummary');
  if (!panel || !toggle || !summary) return;

  if (forceExpand === true) bodyEstimateExpanded = true;
  else if (forceExpand === false) bodyEstimateExpanded = false;
  else if (!hasTarget) {
    bodyEstimateExpanded = true;
  }

  panel.hidden = !bodyEstimateExpanded;
  toggle.setAttribute('aria-expanded', bodyEstimateExpanded ? 'true' : 'false');

  const target = getActiveTarget();
  if (!bodyEstimateExpanded && target) {
    summary.textContent = `Rough target ${formatKcal(target.kcal)} kcal`;
    toggle.setAttribute('aria-label', 'Edit estimate, collapsed');
  } else {
    summary.textContent = bodyEstimateExpanded
      ? 'Rough body estimate'
      : (target ? `Rough target ${formatKcal(target.kcal)} kcal` : 'Rough body estimate');
    toggle.setAttribute(
      'aria-label',
      bodyEstimateExpanded ? 'Rough body estimate, expanded' : 'Edit estimate, collapsed'
    );
  }
}

function expandBodyEstimateAndFocus() {
  bodyEstimateExpanded = true;
  const toggle = document.getElementById('bodyEstimateToggle');
  if (toggle) toggle.dataset.userToggled = '1';
  syncBodyEstimateDisclosure(true);
  const weight = document.getElementById('weight');
  if (weight) weight.focus();
}

function updateProgressUi(sum) {
  const ring = document.getElementById('ringProgress');
  const stickyRing = document.getElementById('stickyRing');
  const totalEl = document.getElementById('diaryTotal');
  const caption = document.getElementById('ringCaption');
  const meta = document.getElementById('ringMeta');
  const stickyLabel = document.getElementById('stickyLabel');
  const wrap = document.getElementById('progressWrap');
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');
  if (!wrap) return;

  const animateMs = prefersReducedMotion() ? 0 : (ringHasPainted ? 320 : 480);
  const glow = document.getElementById('heroGlow');

  if (diaryLoading) {
    if (totalEl) {
      totalEl.textContent = '—';
      totalEl.classList.remove('over');
    }
    if (caption) {
      caption.textContent = '';
      caption.classList.remove('over');
    }
    if (meta) meta.textContent = '';
    setRingProgress(ring, RING_C, 0, false, 0);
    setRingProgress(stickyRing, STICKY_C, 0, false, 0);
    if (stickyLabel) stickyLabel.textContent = '—';
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = '';
    return;
  }

  if (diaryLoadError) {
    setRingProgress(ring, RING_C, 0, false, 0);
    setRingProgress(stickyRing, STICKY_C, 0, false, 0);
    if (caption) caption.textContent = '';
    if (meta) meta.textContent = '';
    if (stickyLabel) stickyLabel.textContent = '—';
    return;
  }

  const target = getActiveTarget();
  if (!target) {
    setRingProgress(ring, RING_C, 0, false, animateMs);
    setRingProgress(stickyRing, STICKY_C, 0, false, animateMs);
    if (totalEl) {
      totalEl.textContent = formatKcal(sum);
      totalEl.classList.remove('over');
    }
    if (caption) {
      caption.textContent = 'kcal';
      caption.classList.remove('over');
    }
    if (meta) {
      meta.innerHTML =
        'Set a rough target below to see progress. ' +
        '<button type="button" class="progress-link" id="openTargetLink">Set target</button>';
      const link = document.getElementById('openTargetLink');
      if (link) link.addEventListener('click', expandBodyEstimateAndFocus);
    }
    if (stickyLabel) stickyLabel.textContent = formatKcal(sum) + ' eaten';
    if (glow && !prefersReducedMotion()) glow.style.opacity = '1';
    ringHasPainted = true;
    return;
  }

  const pctRaw = (sum / target.kcal) * 100;
  const over = sum >= target.kcal;
  const pct = over ? 100 : Math.max(0, Math.min(100, pctRaw));
  const remaining = Math.max(0, Math.round(target.kcal - sum));
  const overAmt = Math.max(0, Math.round(sum - target.kcal));

  setRingProgress(ring, RING_C, pct, over, animateMs);
  setRingProgress(stickyRing, STICKY_C, pct, over, animateMs);

  if (totalEl) {
    totalEl.textContent = over ? formatKcal(overAmt) : formatKcal(remaining);
    totalEl.classList.toggle('over', over);
  }
  if (caption) {
    caption.textContent = over ? 'kcal over' : 'kcal left';
    caption.classList.toggle('over', over);
  }
  if (meta) {
    meta.textContent = formatKcal(target.kcal) + ' target · ' + formatKcal(sum) + ' eaten';
  }
  if (stickyLabel) {
    stickyLabel.textContent = over
      ? (formatKcal(overAmt) + ' over')
      : (formatKcal(remaining) + ' left');
  }
  if (fill) {
    fill.style.width = pct + '%';
    fill.className = 'progress-fill' + (over ? ' over' : sum > 0 ? ' under' : '');
  }
  if (text) {
    text.textContent = over
      ? `${formatKcal(sum)} of ${formatKcal(target.kcal)} kcal · ${formatKcal(overAmt)} over target`
      : `${formatKcal(sum)} of ${formatKcal(target.kcal)} kcal`;
  }
  if (glow) glow.style.opacity = '1';
  ringHasPainted = true;
}


function calc(persistTargets) {
  const w = parseFloat(document.getElementById('weight').value) || 0;
  const h = parseFloat(document.getElementById('height').value) || 0;
  const age = parseFloat(document.getElementById('age').value) || 0;
  const sex = document.getElementById('sex').value;
  const act = parseFloat(document.getElementById('activity').value);
  const resultEl = document.getElementById('result');

  if (w <= 0 || h <= 0 || age <= 0) {
    resultEl.innerHTML = '';
    return;
  }

  const bmi = w / Math.pow(h / 100, 2);
  let category = 'Normal';
  if (bmi < 18.5) category = 'Underweight';
  else if (bmi < 25) category = 'Normal';
  else if (bmi < 30) category = 'Overweight';
  else category = 'Obese';

  const bmr = sex === 'm' ? 10 * w + 6.25 * h - 5 * age + 5 : 10 * w + 6.25 * h - 5 * age - 161;
  const tdee = bmr * act;
  const mild = tdee - 300;
  const aggressive = tdee - 500;

  if (persistTargets) {
    saveTargets(tdee, mild);
    saveBmiInputs();
  }

  resultEl.innerHTML = `
    <div>BMI <span class="estimate-caption">(estimate)</span></div>
    <div class="big">${bmi.toFixed(1)} <span class="unit">(${escapeHtml(category)})</span></div>
    <div style="margin-top:14px">BMR (basal): ~${Math.round(bmr)} kcal/day <span class="estimate-caption">estimate</span></div>
    <div>TDEE (maintenance): ~${Math.round(tdee)} kcal/day <span class="estimate-caption">estimate</span></div>
    <div style="margin-top:8px;color:var(--text-secondary);font-size:0.9rem">
      Mild deficit (−300): ${Math.round(mild)} · Aggressive (−500): ${Math.round(aggressive)}
    </div>
    <p class="estimate-caption" style="margin-top:10px">Progress uses the mild deficit as your rough target.</p>
  `;

  syncBodyEstimateDisclosure();
  if (currentUser) {
    const sum = (lastDiaryRows || []).reduce((a, r) => a + (Number(r.kcal_logged) || 0), 0);
    updateProgressUi(sum);
  }
}

function showFoodResult(html, isError) {
  const el = document.getElementById('foodResult');
  el.hidden = false;
  // Empty lookup → geometric empty plate (no emoji)
  if (isError && typeof html === 'string' && /no match|no foods|no estimate returned/i.test(html)) {
    el.classList.remove('error', 'loading-msg');
    el.innerHTML = emptyPlateSvg(false);
    return;
  }
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
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.setAttribute('aria-label', on ? 'Dictate food' : 'Dictate food');
  btn.title = on ? 'Listening…' : 'Dictate food';
  const label = btn.querySelector('.mic-label');
  if (label) label.textContent = on ? 'Listening…' : '';
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
    setMicStatus('Microphone not supported in this browser. Type a food name instead (Chrome works best).', true);
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
      setMicStatus('Listening…');
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
        setMicStatus('Got it — edit if needed, then Look up or Estimate.');
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
        setMicStatus('Microphone permission denied. Allow mic access in the browser, or type instead.', true);
      } else if (err === 'no-speech') {
        setMicStatus('No speech detected. Try again or type a name.');
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
    ? `<span class="estimate-badge">Estimate, not a database value${food.confidence ? ' · ' + escapeHtml(food.confidence) : ''}</span>`
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
  const todaySection = document.getElementById('todaySection');
  const listSection = document.getElementById('diarySection');
  const list = document.getElementById('diaryList');
  const total = document.getElementById('diaryTotal');
  const sub = document.getElementById('diarySub');
  const err = document.getElementById('todayError');
  const emptyToday = document.getElementById('emptyToday');
  if (todaySection) todaySection.hidden = true;
  if (listSection) listSection.hidden = true;
  if (list) list.innerHTML = '';
  if (total) {
    total.textContent = '0';
    total.classList.remove('over');
  }
  if (sub) sub.textContent = '';
  if (err) err.hidden = true;
  if (emptyToday) emptyToday.hidden = true;
  lastDiaryRows = [];
  diaryLoadError = false;
  diaryLoading = false;
  ringHasPainted = false;
  updateStickyVisibility(false);
}

function renderDiary(rows) {
  const todaySection = document.getElementById('todaySection');
  const listSection = document.getElementById('diarySection');
  const list = document.getElementById('diaryList');
  const totalEl = document.getElementById('diaryTotal');
  const sub = document.getElementById('diarySub');
  const err = document.getElementById('todayError');
  if (!todaySection || !list) return;

  todaySection.hidden = false;
  diaryLoadError = false;
  diaryLoading = false;
  if (err) err.hidden = true;
  syncDiaryChrome();

  const items = rows || [];
  lastDiaryRows = items;
  let sum = 0;
  items.forEach((r) => { sum += Number(r.kcal_logged) || 0; });
  totalEl.textContent = formatKcal(sum);
  updateProgressUi(sum);

  const emptyToday = document.getElementById('emptyToday');

  if (!items.length) {
    if (sub) sub.textContent = '';
    list.innerHTML = '';
    if (listSection) {
      listSection.hidden = false;
    }
    if (emptyToday) emptyToday.hidden = false;
    return;
  }

  if (emptyToday) emptyToday.hidden = true;
  if (sub) sub.textContent = items.length + (items.length === 1 ? ' item' : ' items');
  if (listSection) listSection.hidden = false;
  list.innerHTML = items.map((r) => {
    const qty = r.quantity != null ? r.quantity : 1;
    const label = r.serving_label ? ` · ${escapeHtml(String(r.serving_label))}` : '';
    const time = formatLogTime(r.created_at);
    const name = r.name || 'Food';
    return `
      <li class="diary-item" data-id="${r.id}">
        <div class="diary-item-main">
          <div class="diary-item-name">${escapeHtml(name)}</div>
          <div class="diary-item-meta">${escapeHtml(String(qty))}×${label}${time ? ' · ' + escapeHtml(time) : ''}</div>
        </div>
        <div class="diary-item-actions">
          <div class="diary-item-kcal">${Math.round(Number(r.kcal_logged) || 0)}</div>
          <button type="button" class="btn-delete" data-delete-id="${r.id}" aria-label="Remove ${escapeHtml(name)}">Remove</button>
        </div>
      </li>`;
  }).join('');

  list.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', () => deleteLogEntry(btn.getAttribute('data-delete-id')));
  });
}

async function loadDiary() {
  const todaySection = document.getElementById('todaySection');
  const listSection = document.getElementById('diarySection');
  const sub = document.getElementById('diarySub');
  const err = document.getElementById('todayError');
  const totalEl = document.getElementById('diaryTotal');
  const list = document.getElementById('diaryList');

  if (!currentUser || !supabase) {
    clearDiaryUi();
    return;
  }

  todaySection.hidden = false;
  syncDiaryChrome();
  diaryLoading = true;
  diaryLoadError = false;
  if (err) err.hidden = true;
  if (sub) sub.textContent = 'Loading day…';
  if (totalEl) totalEl.textContent = '—';
  if (list) list.innerHTML = '';
  if (listSection) listSection.hidden = true;
  const emptyToday = document.getElementById('emptyToday');
  if (emptyToday) emptyToday.hidden = true;
  updateProgressUi(0);

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
  } catch (e) {
    diaryLoading = false;
    diaryLoadError = true;
    if (sub) sub.textContent = '';
    if (totalEl) totalEl.textContent = '—';
    if (list) list.innerHTML = '';
    if (listSection) listSection.hidden = true;
    if (err) err.hidden = false;
    updateProgressUi(0);
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

function isValidQuantity() {
  const qtyInput = document.getElementById('logQty');
  const qty = parseFloat(qtyInput && qtyInput.value);
  return Number.isFinite(qty) && qty > 0;
}

function updateLogControls() {
  const panel = document.getElementById('logPanel');
  const btn = document.getElementById('logCaloriesBtn');
  const hint = document.getElementById('logHint');
  const qtyError = document.getElementById('qtyError');
  if (!panel || !btn) return;

  const hasResult = !!lastFoodResult && !lastFoodResult._isError;
  const kcalInfo = hasResult ? baseKcalForLog(lastFoodResult) : null;
  const signedIn = !!currentUser;
  const qtyOk = isValidQuantity();

  panel.hidden = !hasResult;

  if (qtyError) qtyError.hidden = !hasResult || qtyOk;

  if (!hasResult) {
    btn.disabled = true;
    return;
  }

  if (!signedIn) {
    btn.disabled = true;
    hint.textContent = 'Sign in with Google to add this to your diary.';
    return;
  }

  if (!kcalInfo) {
    btn.disabled = true;
    hint.textContent = 'No calorie value available to log for this item.';
    return;
  }

  if (!qtyOk) {
    btn.disabled = true;
    hint.textContent = 'Enter a quantity.';
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
  // Pass 2: route inline success to toast (compat shim)
  showToast(msg || 'Added', '', 'success');
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

  if (!isValidQuantity()) {
    updateLogControls();
    return;
  }

  let qty = parseFloat(qtyInput.value);
  qtyInput.value = String(qty);

  const kcalLogged = Math.round(kcalInfo.kcal * qty);
  const food = lastFoodResult;

  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = 'Saving…';

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

    {
      const prior = (lastDiaryRows || []).reduce((a, r) => a + (Number(r.kcal_logged) || 0), 0);
      const after = prior + kcalLogged;
      const target = getActiveTarget();
      const crossed = target && after >= target.kcal;
      const name = (food && food.name) ? String(food.name) : 'Food';
      showToast('Added · ' + name, formatKcal(kcalLogged) + ' kcal', crossed ? 'caution' : 'success');
    }
    logCooldownedUntil = Date.now() + LOG_COOLDOWN_MS;
    setTimeout(updateLogControls, LOG_COOLDOWN_MS + 50);

    lastFoodResult = null;
    document.getElementById('foodResult').hidden = true;
    document.getElementById('foodResult').innerHTML = '';
    document.getElementById('foodQuery').value = '';
    qtyInput.value = '1';
    updateLogControls();

    await loadDiary();
    const q = document.getElementById('foodQuery');
    if (q) q.focus();
  } catch (err) {
    const msg = err && err.message ? err.message : 'Log failed';
    showToast(msg, '', 'danger');
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
    showFoodResult('Describe a meal, then tap Estimate.', true);
    updateLogControls();
    return;
  }

  input.value = raw;

  const btn = document.getElementById('estimateBtn');
  const lookupBtn = document.getElementById('lookupBtn');
  const scanBtn = document.getElementById('scanBtn');
  btn.disabled = true;
  lookupBtn.disabled = true;
  if (scanBtn) scanBtn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Estimating…';
  lastFoodResult = null;
  updateLogControls();
  document.getElementById('logSuccess').hidden = true;
  showFoodResult('Estimating…', false);

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
      showFoodResult('No estimate returned. Try another description.', true);
      updateLogControls();
      return;
    }

    lastFoodResult = results[0];
    showFoodResult(renderFoodCard(results[0]), false);
    updateLogControls();
  } catch (err) {
    lastFoodResult = { _isError: true };
    showFoodResult(escapeHtml(err.message || 'Estimate failed. Try again.'), true);
    updateLogControls();
  } finally {
    btn.disabled = false;
    lookupBtn.disabled = false;
    if (scanBtn) scanBtn.disabled = false;
    btn.textContent = prev;
  }
}

async function lookupFood(forcedValue) {
  stopSpeechRecognition();
  const input = document.getElementById('foodQuery');
  const raw = forcedValue != null ? String(forcedValue) : (input.value || '').trim();
  if (!raw) {
    lastFoodResult = null;
    showFoodResult('Enter a food name or barcode.', true);
    updateLogControls();
    return;
  }

  input.value = raw;

  const btn = document.getElementById('lookupBtn');
  const estimateBtn = document.getElementById('estimateBtn');
  const scanBtn = document.getElementById('scanBtn');
  btn.disabled = true;
  if (estimateBtn) estimateBtn.disabled = true;
  if (scanBtn) scanBtn.disabled = true;
  btn.textContent = 'Looking up…';
  lastFoodResult = null;
  updateLogControls();
  document.getElementById('logSuccess').hidden = true;

  const isBarcode = looksLikeBarcode(raw);
  showFoodResult('Looking up…', false);

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
      lastFoodResult = { _isError: true };
      showFoodResult(
        `No match for ‘${escapeHtml(raw)}’. Try another name or estimate the meal.`,
        true
      );
      updateLogControls();
      return;
    }

    lastFoodResult = results[0];
    let extras = '';
    if (results.length > 1) {
      extras = `<div class="food-meta" style="margin-top:12px">Other matches:</div><ul style="margin:6px 0 0 18px;color:var(--text-secondary);font-size:0.85rem">`;
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
    showFoodResult(escapeHtml(err.message || 'Lookup failed. Check your connection and try again.'), true);
    updateLogControls();
  } finally {
    btn.disabled = false;
    if (estimateBtn) estimateBtn.disabled = false;
    if (scanBtn) scanBtn.disabled = false;
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
  scanBtn.textContent = 'Scanning…';

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
    scanBtn.textContent = 'Scan';
    const msg = String(err && err.message ? err.message : err);
    if (/NotAllowedError|Permission/i.test(msg)) {
      showFoodResult('Camera permission denied. Allow camera access, or type the barcode.', true);
    } else if (/NotFoundError|DevicesNotFound/i.test(msg)) {
      showFoodResult('No camera found on this device. Type the barcode instead.', true);
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
  scanBtn.textContent = 'Scan';
  scanBusy = false;
}

function setAuthStatus(msg, isError) {
  const el = document.getElementById('authStatus') || document.getElementById('signOutStatus');
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

function updateAddFoodCopy(signedIn) {
  const title = document.getElementById('addFoodTitle');
  const helper = document.getElementById('addFoodHelper');
  if (title) title.textContent = signedIn ? 'Add food' : 'Food calorie lookup';
  if (helper) {
    helper.textContent = signedIn
      ? 'You can also scan a barcode, estimate a meal, or use the mic.'
      : 'Try a lookup before signing in. Adding to your diary needs a Google account.';
  }
}

function renderAuthUi(user) {
  const headerEmail = document.getElementById('headerEmail');
  const diaryGate = document.getElementById('diaryGate');

  currentUser = user || null;
  const signedIn = !!user;

  setExclusiveAuth(signedIn);
  reorderRegions(signedIn);
  updateAddFoodCopy(signedIn);

  if (!user) {
    if (headerEmail) {
      headerEmail.hidden = true;
      headerEmail.textContent = '';
      headerEmail.removeAttribute('title');
    }
    if (diaryGate) diaryGate.hidden = false;
    bodyEstimateExpanded = true;
    const toggle = document.getElementById('bodyEstimateToggle');
    if (toggle) delete toggle.dataset.userToggled;
    syncBodyEstimateDisclosure(true);
    updateLogControls();
    clearDiaryUi();
    updateStickyVisibility(false);
    return;
  }

  if (headerEmail) {
    headerEmail.hidden = false;
    headerEmail.textContent = user.email || 'Signed in';
    headerEmail.title = user.email || '';
  }
  if (diaryGate) diaryGate.hidden = true;

  const toggle = document.getElementById('bodyEstimateToggle');
  if (getActiveTarget() && !(toggle && toggle.dataset.userToggled)) {
    syncBodyEstimateDisclosure(false);
  } else if (!getActiveTarget()) {
    syncBodyEstimateDisclosure(true);
  } else {
    syncBodyEstimateDisclosure();
  }
  updateLogControls();
  diaryViewDate = startOfLocalDay(new Date());
  initStickyObserver();
  loadDiary();
}

function bindGoogleSignIn(btn) {
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', async () => {
    setAuthStatus('');
    if (!supabase) {
      setAuthStatus('Auth not ready. Refresh and try again.', true);
      return;
    }
    btn.disabled = true;
    const prevHtml = btn.innerHTML;
    btn.textContent = 'Signing in…';
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
      setAuthStatus(err.message || 'Sign-in failed or was cancelled.', true);
      btn.disabled = false;
      btn.innerHTML = prevHtml;
    }
  });
}

function bindSignOut(btn) {
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', async () => {
    setAuthStatus('');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Signing out…';
    try {
      await supabase.auth.signOut();
      renderAuthUi(null);
    } catch (err) {
      setAuthStatus(err.message || 'Sign-out failed.', true);
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
}

async function initAuth() {
  const btn = document.getElementById('googleSignInBtn');

  if (typeof window.supabase === 'undefined') {
    setAuthStatus('Auth library failed to load. Refresh and try again.', true);
    if (btn) btn.disabled = true;
    return;
  }

  let cfg;
  try {
    const res = await fetch(CONFIG_URL);
    cfg = await res.json();
  } catch (e) {
    setAuthStatus('Could not load auth config.', true);
    if (btn) btn.disabled = true;
    return;
  }

  if (!cfg.authConfigured || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    setAuthStatus('Auth not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY on Cloudflare Pages, then redeploy.', true);
    if (btn) btn.disabled = true;
    return;
  }

  const createClient = window.supabase.createClient;
  if (!createClient) {
    setAuthStatus('Supabase client missing.', true);
    if (btn) btn.disabled = true;
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

  bindGoogleSignIn(document.getElementById('googleSignInBtn'));
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) bindSignOut(signOutBtn);
}

function initBodyEstimateUi() {
  const toggle = document.getElementById('bodyEstimateToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      toggle.dataset.userToggled = '1';
      bodyEstimateExpanded = !bodyEstimateExpanded;
      syncBodyEstimateDisclosure(bodyEstimateExpanded);
    });
  }
  ['weight', 'height', 'age', 'sex', 'activity'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => calc(true));
    el.addEventListener('change', () => calc(true));
  });
}

const hadStoredInputs = !!localStorage.getItem(BMI_INPUTS_KEY);
restoreBmiInputs();
initBodyEstimateUi();
calc(hadStoredInputs || !!getActiveTarget());
syncBodyEstimateDisclosure();

(function initFoodLookup() {
  document.getElementById('lookupBtn').addEventListener('click', () => {
    setMethodChip('lookup');
    lookupFood();
  });
  document.getElementById('estimateBtn').addEventListener('click', () => {
    setMethodChip('estimate');
    estimateMeal();
  });
  document.getElementById('scanBtn').addEventListener('click', () => {
    setMethodChip('scan');
    startScanner();
  });
  document.getElementById('stopScanBtn').addEventListener('click', () => stopScanner());

  const chipScan = document.getElementById('methodChipScan');
  const chipLookup = document.getElementById('methodChipLookup');
  const chipEstimate = document.getElementById('methodChipEstimate');
  if (chipScan) chipScan.addEventListener('click', () => { setMethodChip('scan'); startScanner(); });
  if (chipLookup) chipLookup.addEventListener('click', () => {
    setMethodChip('lookup');
    const q = (document.getElementById('foodQuery').value || '').trim();
    if (q) lookupFood();
  });
  if (chipEstimate) chipEstimate.addEventListener('click', () => {
    setMethodChip('estimate');
    const q = (document.getElementById('foodQuery').value || '').trim();
    if (q) estimateMeal();
  });
  setMethodChip('lookup');

  document.getElementById('foodQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedMethod === 'estimate') estimateMeal();
      else lookupFood();
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
  const retry = document.getElementById('diaryRetryBtn');
  if (retry) retry.addEventListener('click', () => loadDiary());

  initSpeechUi();
  const welcomeSecondary = document.getElementById('welcomeSecondary');
  if (welcomeSecondary) {
    welcomeSecondary.addEventListener('click', () => {
      expandBodyEstimateAndFocus();
      const section = document.getElementById('bodyEstimateSection');
      if (section) section.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });
  }
  updateLogControls();
  reorderRegions(false);
  updateAddFoodCopy(false);
  setExclusiveAuth(false);
})();

initAuth();
