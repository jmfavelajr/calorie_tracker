/**
 * POST /api/meal-estimate
 * Body: { "phrase": "eggs benedict with hash browns at ihop" }
 * Env: XAI_API_KEY, optional XAI_MODEL
 *
 * Policy:
 *  - Count ONLY foods/items explicitly named in the phrase
 *  - Do NOT invent sides or standard plate add-ons
 *  - Restaurant venue may imply prep style (oil/butter), not extra dishes
 *  - assumptions + includes act as a visual receipt for the user
 *
 * Stabilization:
 *  - phrase normalization (case / from→at / known chains)
 *  - temperature 0 + seed
 *  - Cloudflare Cache API by normalized phrase (7 days), key version v2
 */

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const CACHE_VERSION = 'v2'; // bump when estimate policy changes

const SYSTEM = `You estimate calories and macros for meals from short natural-language phrases.
Return ONLY valid JSON (no markdown fences) with this exact shape:
{
  "name": string,
  "venue": string|null,
  "servingLabel": string,
  "kcal": number,
  "kcalLow": number,
  "kcalHigh": number,
  "protein_g": number,
  "carbs_g": number,
  "fat_g": number,
  "confidence": "high"|"medium"|"low",
  "includes": string[],
  "assumptions": string[],
  "notes": string|null
}
Rules — scope (critical):
- Count ONLY foods and components the user explicitly named in the phrase.
- Do NOT add sides, drinks, or "usual plate" extras that were not mentioned.
  Example: "eggs benedict at IHOP" = the benedict only. No hash browns, fruit, or pancakes unless named.
  Example: "eggs benedict with hash browns at IHOP" = benedict + hash browns only.
- Core components of a named dish are OK (e.g. Eggs Benedict implies muffin, eggs, hollandaise, Canadian bacon) because they define that dish — not optional sides.
- If a restaurant or chain is named, apply restaurant-style preparation (extra butter/oil vs home cooking) as a stated factor only — still no unlisted sides.
- If homemade or no venue, use typical home preparation.

Rules — numbers:
- kcal is ONE fixed best estimate for the scoped items above (the number to log).
- For the same normalized phrase, always return the same kcal and macros (deterministic lookup behavior).
- protein_g, carbs_g, fat_g are grams for that same scope.
- kcalLow and kcalHigh are a realistic variance band around that fixed kcal.
- Ignore capitalization. "at" vs "from" must not change the estimate.

Rules — receipt fields:
- includes: short list of what was counted (dish parts + any named sides). 2–8 items.
- assumptions: 2–5 bullets. Must make scope obvious, e.g. "No side included (not mentioned)" when none was named, and note restaurant prep if applicable.
- confidence is low if the phrase is vague (e.g. only "lunch" or "food").
- This is an estimate, not lab nutrition data.`;

const CHAIN_ALIASES = [
  { re: /\bihop\b/gi, canonical: 'IHOP' },
  { re: /\bdenny'?s\b/gi, canonical: "Denny's" },
  { re: /\bwaffle\s*house\b/gi, canonical: 'Waffle House' },
  { re: /\bmcdonald'?s\b/gi, canonical: "McDonald's" },
  { re: /\bburger\s*king\b/gi, canonical: 'Burger King' },
  { re: /\bwendy'?s\b/gi, canonical: "Wendy's" },
  { re: /\bchipotle\b/gi, canonical: 'Chipotle' },
  { re: /\bpanera(\s*bread)?\b/gi, canonical: 'Panera' },
  { re: /\bstarbucks\b/gi, canonical: 'Starbucks' },
  { re: /\btaco\s*bell\b/gi, canonical: 'Taco Bell' },
  { re: /\bsubway\b/gi, canonical: 'Subway' },
  { re: /\bolive\s*garden\b/gi, canonical: 'Olive Garden' },
  { re: /\bapplebee'?s\b/gi, canonical: "Applebee's" },
  { re: /\boutback(\s*steakhouse)?\b/gi, canonical: 'Outback' },
  { re: /\bchick[-\s]?fil[-\s]?a\b/gi, canonical: 'Chick-fil-A' },
];

function normalizePhrase(raw) {
  let s = String(raw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return { display: '', model: '' };

  s = s.replace(/\bfrom\b/gi, 'at');
  s = s.replace(/\b@\b/g, 'at');

  for (const { re, canonical } of CHAIN_ALIASES) {
    s = s.replace(re, canonical);
  }

  let model = s.toLowerCase();
  for (const { canonical } of CHAIN_ALIASES) {
    const lower = canonical.toLowerCase();
    model = model.replace(new RegExp(lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), canonical);
  }

  model = model.replace(/\s+/g, ' ').trim();
  return { display: model, model };
}

function macroNum(v) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 500) return null;
  return n;
}

function stringList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v
    .map((a) => String(a).slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

function cacheRequestForPhrase(phrase) {
  const key = encodeURIComponent(phrase.toLowerCase());
  return new Request(`https://meal-estimate.local/${CACHE_VERSION}/${key}`, {
    method: 'GET',
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost(context) {
  const key = context.env.XAI_API_KEY;
  if (!key) {
    return json({ error: 'XAI_API_KEY not configured on Cloudflare Pages' }, 500);
  }

  let rawPhrase = '';
  try {
    const body = await context.request.json();
    rawPhrase = String(body.phrase || body.query || '').trim();
  } catch (e) {
    return json({ error: 'Expected JSON body with phrase' }, 400);
  }

  if (!rawPhrase || rawPhrase.length < 2) {
    return json({ error: 'Phrase too short' }, 400);
  }
  if (rawPhrase.length > 400) {
    return json({ error: 'Phrase too long' }, 400);
  }

  const { model: phrase, display } = normalizePhrase(rawPhrase);
  if (!phrase || phrase.length < 2) {
    return json({ error: 'Phrase too short after normalization' }, 400);
  }

  const cacheReq = cacheRequestForPhrase(phrase);
  try {
    const hit = await caches.default.match(cacheReq);
    if (hit) {
      const data = await hit.json();
      if (data && data.results && data.results[0]) {
        data.cached = true;
        data.results[0].rawPhrase = rawPhrase;
        data.results[0].normalizedPhrase = phrase;
      }
      return json(data, 200, {
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
        'X-Meal-Estimate-Cache': 'HIT',
      });
    }
  } catch (e) {
    // continue
  }

  const model = context.env.XAI_MODEL || 'grok-3';

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        seed: 42,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content:
              `Estimate calories and macros for this meal phrase.\n` +
              `Count only explicitly named items. Do not invent sides.\n` +
              `Phrase (normalized):\n${phrase}`,
          },
        ],
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data.error && (data.error.message || data.error)) ||
        data.message ||
        `xAI error (${res.status})`;
      return json({ error: String(msg) }, 502);
    }

    const raw =
      (data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content) ||
      '';
    const cleaned = String(raw)
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return json({ error: 'Model returned non-JSON', raw: cleaned.slice(0, 500) }, 502);
    }

    const kcal = Math.round(Number(parsed.kcal));
    if (!Number.isFinite(kcal) || kcal <= 0 || kcal > 6000) {
      return json({ error: 'Invalid kcal in model response', parsed }, 502);
    }

    let kcalLow = Math.round(Number(parsed.kcalLow));
    let kcalHigh = Math.round(Number(parsed.kcalHigh));
    if (!Number.isFinite(kcalLow) || kcalLow <= 0) kcalLow = Math.round(kcal * 0.75);
    if (!Number.isFinite(kcalHigh) || kcalHigh < kcal) kcalHigh = Math.round(kcal * 1.25);

    const confidence = ['high', 'medium', 'low'].includes(parsed.confidence)
      ? parsed.confidence
      : 'medium';

    const includes = stringList(parsed.includes, 8, 80);
    const assumptions = stringList(parsed.assumptions, 6, 140);

    const result = {
      source: 'grok_estimate',
      name: String(parsed.name || display || phrase).slice(0, 200),
      brand: parsed.venue ? String(parsed.venue).slice(0, 120) : null,
      category: null,
      barcode: null,
      servingLabel: String(parsed.servingLabel || '1 serving').slice(0, 80),
      servingKcal: kcal,
      kcalPer100: null,
      kcalLow,
      kcalHigh,
      protein_g: macroNum(parsed.protein_g),
      carbs_g: macroNum(parsed.carbs_g),
      fat_g: macroNum(parsed.fat_g),
      confidence,
      includes,
      assumptions,
      notes: parsed.notes ? String(parsed.notes).slice(0, 300) : null,
      rawPhrase,
      normalizedPhrase: phrase,
      link: null,
    };

    const payload = {
      mode: 'estimate',
      found: true,
      cached: false,
      results: [result],
    };

    const response = json(payload, 200, {
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      'X-Meal-Estimate-Cache': 'MISS',
    });

    try {
      const toStore = new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
        },
      });
      await caches.default.put(cacheReq, toStore);
    } catch (e) {}

    return response;
  } catch (err) {
    return json({ error: err.message || 'Estimate failed' }, 500);
  }
}
