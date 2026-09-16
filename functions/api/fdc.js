/**
 * Multi-source food lookup (secrets on Cloudflare only):
 *   USDA_API_KEY
 *   APININJAS_API_KEY
 *   CALORIESAPI_KEY     (Calorie API — barcode + text search)
 *
 * Routing:
 *   Numeric barcode → USDA → Calorie API barcode
 *   Text query      → API Ninjas → Calorie API food search
 *
 * GET /api/fdc?barcode=04963406
 * GET /api/fdc?query=1%20large%20apple
 */

const FDC_SEARCH = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const NINJAS_NUTRITION = 'https://api.api-ninjas.com/v1/nutrition';
const CALORIE_API_BASE = 'https://calorieapiadmin.com/api/v1';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=120',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function toGtin13(barcode) {
  const d = String(barcode).replace(/\D/g, '');
  if (d.length >= 13) return d.slice(-13);
  return d.padStart(13, '0');
}

function looksLikeBarcode(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 14) return false;
  const compact = s.replace(/[\s-]/g, '');
  return digits.length >= compact.length * 0.9;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function nutrientAmount(list, names) {
  if (!Array.isArray(list)) return null;
  const want = names.map((n) => n.toLowerCase());
  const hit = list.find((n) => want.includes(String(n.nutrient_name || n.name || '').toLowerCase()));
  return hit ? num(hit.amount ?? hit.value) : null;
}

function usdaEnergyKcal(food) {
  const nutrients = food.foodNutrients || [];
  const energy =
    nutrients.find(
      (n) =>
        (n.nutrientName === 'Energy' || n.nutrientNumber === '208') &&
        String(n.unitName || '').toUpperCase() === 'KCAL'
    ) ||
    nutrients.find(
      (n) =>
        String(n.nutrientName || '').toLowerCase().includes('energy') &&
        String(n.unitName || '').toUpperCase() === 'KCAL'
    );
  if (!energy) return null;
  return typeof energy.value === 'number' ? energy.value : parseFloat(energy.value);
}

function normalizeUsda(food, barcode) {
  const kcal100 = usdaEnergyKcal(food);
  const size = food.servingSize;
  const unit = String(food.servingSizeUnit || '').toUpperCase();
  let servingKcal = null;
  if (kcal100 != null && size && (unit === 'G' || unit === 'GRM' || unit === 'ML' || unit === 'MLT')) {
    servingKcal = Math.round((kcal100 * size) / 100);
  }
  const servingLabel =
    food.householdServingFullText ||
    (size && food.servingSizeUnit ? `${size} ${food.servingSizeUnit}` : null);

  return {
    source: 'usda',
    name: food.description || 'Unknown product',
    brand: food.brandOwner || food.brandName || null,
    category: food.foodCategory || null,
    barcode: food.gtinUpc || barcode,
    kcalPer100: kcal100 != null ? Math.round(kcal100) : null,
    servingLabel,
    servingKcal,
    packageWeight: food.packageWeight || null,
    id: food.fdcId != null ? String(food.fdcId) : null,
    link: food.fdcId ? `https://fdc.nal.usda.gov/food-details/${food.fdcId}/nutrients` : null,
  };
}

function normalizeNinjas(items, query) {
  if (!Array.isArray(items) || !items.length) return [];
  return items.map((item) => {
    const servingG = item.serving_size_g != null ? parseFloat(item.serving_size_g) : null;
    // calories is a premium field on some API Ninjas plans — may be undefined
    const calories = item.calories != null ? parseFloat(item.calories) : null;
    let kcal100 = null;
    if (calories != null && servingG && servingG > 0) {
      kcal100 = Math.round((calories / servingG) * 100);
    }
    return {
      source: 'apininjas',
      name: item.name || query,
      brand: null,
      category: null,
      barcode: null,
      kcalPer100: kcal100,
      servingLabel: servingG != null ? `${servingG} g` : null,
      servingKcal: calories != null && !Number.isNaN(calories) ? Math.round(calories) : null,
      protein_g: item.protein_g != null ? parseFloat(item.protein_g) : null,
      carbs_g: item.carbohydrates_total_g != null ? parseFloat(item.carbohydrates_total_g) : null,
      fat_g: item.fat_total_g != null ? parseFloat(item.fat_total_g) : null,
      id: null,
      link: 'https://api-ninjas.com/api/nutrition',
      _hasCalories: calories != null && !Number.isNaN(calories),
    };
  });
}

/** Normalize Calorie API search/barcode food objects (actual field names). */
function normalizeCalorieApiFood(item, barcode) {
  if (!item || typeof item !== 'object') return null;

  const name = item.name || item.food_name || item.product_name || 'Unknown product';
  const brand = item.brand_name || item.brand || null;
  const category = item.category_name || item.category || item.food_category || null;

  // Per-100g macros (documented field names)
  let kcal100 =
    num(item.calories_100g) ??
    num(item.calories_per_100g) ??
    nutrientAmount(item.nutrients, ['Calories', 'Energy']);

  let protein =
    num(item.protein_100g) ??
    num(item.protein_g) ??
    nutrientAmount(item.nutrients, ['Protein']);
  let carbs =
    num(item.carbs_100g) ??
    num(item.carbohydrates_100g) ??
    nutrientAmount(item.nutrients, ['Carbohydrates', 'Carbs']);
  let fat =
    num(item.fat_100g) ??
    num(item.fat_g) ??
    nutrientAmount(item.nutrients, ['Fat', 'Total lipid (fat)']);

  // Serving / portion
  let servingLabel = null;
  let servingKcal = null;
  const portionGrams =
    num(item.default_portion && item.default_portion.grams) ??
    num(item.serving_size);

  if (item.default_portion && item.default_portion.label) {
    servingLabel = item.default_portion.label;
  } else if (typeof item.serving === 'string') {
    servingLabel = item.serving;
  } else if (portionGrams != null && item.serving_unit) {
    servingLabel = `${portionGrams} ${item.serving_unit}`;
  }

  // Portion-scaled calories
  servingKcal =
    nutrientAmount(item.portion_nutrients, ['Calories', 'Energy']) ??
    num(item.meal && item.meal.calories) ??
    null;

  if (servingKcal == null && kcal100 != null && portionGrams != null) {
    servingKcal = Math.round((kcal100 * portionGrams) / 100);
  }

  if (kcal100 != null) kcal100 = Math.round(kcal100);
  if (servingKcal != null) servingKcal = Math.round(servingKcal);

  const id = item.id != null ? String(item.id) : null;

  return {
    source: 'calorieapi',
    name,
    brand,
    category,
    barcode: barcode || item.upc || item.barcode || null,
    kcalPer100: kcal100,
    servingLabel,
    servingKcal,
    protein_g: protein,
    carbs_g: carbs,
    fat_g: fat,
    id,
    link: 'https://calorieapi.com',
  };
}

function unwrapCalorieList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.foods)) return data.foods;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.items)) return data.items;
  if (data.name || data.food_name || data.id || data.calories_100g) return [data];
  return [];
}

async function searchUsda(env, barcode) {
  const key = env.USDA_API_KEY || env.FDC_API_KEY;
  if (!key) return { ok: false, skip: true, reason: 'USDA_API_KEY not set' };

  const url =
    `${FDC_SEARCH}?api_key=${encodeURIComponent(key)}` +
    `&query=${encodeURIComponent(barcode)}&dataType=Branded&pageSize=10`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, reason: `USDA ${res.status}`, detail: text.slice(0, 200) };
  }
  const data = await res.json();
  const foods = data.foods || [];
  const exact = foods.find((f) => String(f.gtinUpc || '') === barcode) || foods[0];
  if (!exact) return { ok: true, results: [] };
  return { ok: true, results: [normalizeUsda(exact, barcode)] };
}

async function searchNinjas(env, query) {
  const key = env.APININJAS_API_KEY;
  if (!key) return { ok: false, skip: true, reason: 'APININJAS_API_KEY not set' };
  if (!query || !String(query).trim()) return { ok: true, results: [] };

  const url = `${NINJAS_NUTRITION}?query=${encodeURIComponent(String(query).trim())}`;
  const res = await fetch(url, {
    headers: { 'X-Api-Key': key, Accept: 'application/json' },
  });

  if (!res.ok) {
    const t = await res.text();
    return { ok: false, reason: `API Ninjas ${res.status}`, detail: t.slice(0, 200) };
  }

  const data = await res.json();
  const all = normalizeNinjas(data, query);
  // If plan omits premium `calories`, treat as miss so Calorie API can fill in
  const withCals = all.filter((r) => r._hasCalories);
  if (all.length && !withCals.length) {
    return {
      ok: true,
      results: [],
      note: 'API Ninjas returned food(s) but no calories (field may require a paid Ninjas plan)',
    };
  }
  return { ok: true, results: withCals.map(({ _hasCalories, ...rest }) => rest) };
}

function calorieApiKey(env) {
  return env.CALORIESAPI_KEY || env.CALORIEAPI_KEY || env.CALORIE_API_KEY;
}

async function searchCalorieApiBarcode(env, barcode) {
  const key = calorieApiKey(env);
  if (!key) return { ok: false, skip: true, reason: 'CALORIESAPI_KEY not set' };

  const upc = String(barcode).replace(/\D/g, '');
  const url = `${CALORIE_API_BASE}/search/barcode/${encodeURIComponent(upc)}`;
  const res = await fetch(url, {
    headers: { 'X-API-Key': key, Accept: 'application/json' },
  });

  if (res.status === 404) return { ok: true, results: [] };
  if (!res.ok) {
    const t = await res.text();
    return { ok: false, reason: `Calorie API barcode ${res.status}`, detail: t.slice(0, 200) };
  }

  const data = await res.json();
  const list = unwrapCalorieList(data);
  const results = list.map((f) => normalizeCalorieApiFood(f, upc)).filter(Boolean);
  return { ok: true, results };
}

async function searchCalorieApiText(env, query) {
  const key = calorieApiKey(env);
  if (!key) return { ok: false, skip: true, reason: 'CALORIESAPI_KEY not set' };

  const url = `${CALORIE_API_BASE}/search/foods?q=${encodeURIComponent(query)}&limit=5`;
  const res = await fetch(url, {
    headers: { 'X-API-Key': key, Accept: 'application/json' },
  });

  if (!res.ok) {
    const t = await res.text();
    return { ok: false, reason: `Calorie API search ${res.status}`, detail: t.slice(0, 200) };
  }

  const data = await res.json();
  const list = unwrapCalorieList(data).slice(0, 5);
  const results = list.map((f) => normalizeCalorieApiFood(f, null)).filter(Boolean);
  return { ok: true, results };
}

async function runBarcodeCascade(env, barcode) {
  const sourcesTried = [];
  const notes = [];
  let results = [];

  sourcesTried.push('usda');
  try {
    const usda = await searchUsda(env, barcode);
    if (usda.skip) notes.push(usda.reason);
    else if (!usda.ok) notes.push(usda.reason);
    else if (usda.results.length) results = results.concat(usda.results);
  } catch (e) {
    notes.push('USDA: ' + String(e.message || e));
  }

  if (!results.length) {
    sourcesTried.push('calorieapi');
    try {
      const ca = await searchCalorieApiBarcode(env, barcode);
      if (ca.skip) notes.push(ca.reason);
      else if (!ca.ok) notes.push(ca.reason);
      else if (ca.results.length) results = results.concat(ca.results);
    } catch (e) {
      notes.push('Calorie API: ' + String(e.message || e));
    }
  }

  return {
    mode: 'barcode',
    barcode,
    gtin13: toGtin13(barcode),
    found: results.length > 0,
    results,
    sourcesTried,
    notes: notes.length ? notes : undefined,
  };
}

async function runTextCascade(env, query) {
  const sourcesTried = [];
  const notes = [];
  let results = [];

  sourcesTried.push('apininjas');
  try {
    const ninjas = await searchNinjas(env, query);
    if (ninjas.skip) notes.push(ninjas.reason);
    else if (!ninjas.ok) notes.push(ninjas.reason);
    else if (ninjas.note) notes.push(ninjas.note);
    else if (ninjas.results.length) results = results.concat(ninjas.results);
  } catch (e) {
    notes.push('API Ninjas: ' + String(e.message || e));
  }

  if (!results.length) {
    sourcesTried.push('calorieapi');
    try {
      const ca = await searchCalorieApiText(env, query);
      if (ca.skip) notes.push(ca.reason);
      else if (!ca.ok) notes.push(ca.reason);
      else if (ca.results.length) results = results.concat(ca.results);
    } catch (e) {
      notes.push('Calorie API: ' + String(e.message || e));
    }
  }

  return {
    mode: 'text',
    query,
    found: results.length > 0,
    results,
    sourcesTried,
    notes: notes.length ? notes : undefined,
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const barcodeParam = String(url.searchParams.get('barcode') || '').trim();
  const queryParam = String(url.searchParams.get('query') || url.searchParams.get('q') || '').trim();

  if (barcodeParam) {
    const barcode = barcodeParam.replace(/\D/g, '');
    if (barcode.length < 6) return json({ error: 'Invalid barcode.' }, 400);
    return json(await runBarcodeCascade(env, barcode));
  }

  if (queryParam) {
    if (looksLikeBarcode(queryParam)) {
      return json(await runBarcodeCascade(env, queryParam.replace(/\D/g, '')));
    }
    return json(await runTextCascade(env, queryParam));
  }

  return json({
    error: 'Provide barcode=… (numeric) or query=… (food name / description).',
  }, 400);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
