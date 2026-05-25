// Shared Supabase relay config. When set, the popup's phone-pairing
// page skips the URL/key form and lets users pair with one click —
// good for closed-tester / production rollouts. Empty strings here
// fall back to the BYO flow (user pastes their own URL + key).
//
// Anon keys are designed to be public-ish — actual security comes
// from RLS policies that match on the per-user `x-pair-id` header
// plus the AES key generated locally per extension. Embedding the
// anon key in the extension bundle is safe by design.

export const DEFAULT_RELAY_URL = 'https://zexbkbkobqdosezkuuqj.supabase.co';

// TODO: paste your Supabase project's anon (publishable) key here.
// Find it in the Supabase dashboard → Settings → API Keys → "anon".
// Leaving this empty falls back to the BYO form.
export const DEFAULT_ANON_KEY = 'sb_publishable_re1-OYQIRxtVQlaT98iEzg_aOa27Lor';

export function hasDefaultRelayConfig(): boolean {
  return DEFAULT_RELAY_URL.length > 0 && DEFAULT_ANON_KEY.length > 0;
}
