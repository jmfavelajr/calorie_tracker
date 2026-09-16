/**
 * Public client config (safe to expose).
 * Set on Cloudflare Pages:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 */
export async function onRequestGet(context) {
  const env = context.env || {};
  const url = env.SUPABASE_URL || '';
  const anonKey = env.SUPABASE_ANON_KEY || '';

  return new Response(
    JSON.stringify({
      supabaseUrl: url,
      supabaseAnonKey: anonKey,
      authConfigured: Boolean(url && anonKey),
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
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
