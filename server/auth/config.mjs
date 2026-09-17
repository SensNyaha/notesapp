export function authConfiguration(env = process.env) {
  const mode = env.AUTH_COOKIE_MODE ?? 'secure';
  const origin = env.APP_ORIGIN ?? 'https://localhost';
  let url;
  try { url = new URL(origin); } catch { throw new Error('APP_ORIGIN must be an origin URL'); }
  if (url.origin !== origin || url.username || url.password) throw new Error('APP_ORIGIN must contain only scheme, host and port');
  if (mode !== 'secure' && mode !== 'localhost') throw new Error('Invalid AUTH_COOKIE_MODE');
  if (mode === 'secure' && url.protocol !== 'https:') throw new Error('Secure cookies require an HTTPS APP_ORIGIN');
  if (mode === 'localhost' && (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Localhost cookie mode only permits a loopback HTTP APP_ORIGIN');
  }
  return { origin, rpId: url.hostname, secure: mode === 'secure', bootstrap: {
    login: env.BOOTSTRAP_ADMIN_LOGIN, password: env.BOOTSTRAP_ADMIN_PASSWORD,
  } };
}
