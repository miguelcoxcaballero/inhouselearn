// The app keeps the Google session like Inhouse Notes (APK ≥ 1.0.7): PKCE with
// the Android OAuth client, a refresh token stored on the device and silent
// renewal, never asking to sign in again. Google and the Android shell are fakes.
const crypto = require('crypto');
const { chromium } = require('playwright');
const { openApp } = require('./mock.cjs');
const check = (label, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : ''));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const ua = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36 InhouseLearnApp/1.0.7';
  const { page, errors } = await openApp(browser, { viewport: { width: 390, height: 844 }, userAgent: ua }, {
    init: () => {
      window.__shell = [];
      window.InhouseLearnApp = { postMessage: (data) => window.__shell.push(JSON.parse(data)) };
      // PKCE needs crypto.subtle, which only exists in a secure context: the real page is
      // https, the test page is http, so SHA-256 is computed by Node here.
      if (!crypto.subtle) {
        Object.defineProperty(crypto, 'subtle', { value: { digest: async (alg, data) => {
          const hex = await window.__sha256(Array.from(new Uint8Array(data.buffer || data)));
          return new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16))).buffer;
        } } });
      }
    }
  });
  await page.exposeFunction('__sha256', (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
  const tokenCalls = [];
  let refreshFails = false;
  await page.route('https://oauth2.googleapis.com/token', async (route) => {
    const body = Object.fromEntries(new URLSearchParams(route.request().postData() || ''));
    tokenCalls.push(body);
    if (body.grant_type === 'refresh_token' && refreshFails) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_grant' }) });
    const reply = body.grant_type === 'authorization_code'
      ? { access_token: 'ya29.first', expires_in: 3599, refresh_token: '1//refresh-token', scope: 'openid' }
      : { access_token: 'ya29.renewed-' + tokenCalls.length, expires_in: 3599, scope: 'openid' };
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(reply) });
  });
  const revokes = [];
  await page.route('https://oauth2.googleapis.com/revoke**', (route) => { revokes.push(route.request().url()); route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' }); });

  // 0. Without the Android client ID the app keeps the web client's one-hour token.
  const legacy = await page.evaluate(async () => { window.__shell = []; requestGoogleAccessTokenInApp('consent', '').catch(() => {}); await new Promise((r) => setTimeout(r, 100)); const m = window.__shell.find((x) => x.type === 'signIn'); return m ? new URL(m.url).searchParams.get('response_type') : ''; });
  check('without an Android OAuth client nothing changes (implicit token flow)', legacy === 'token', legacy);

  // 1. With it: PKCE, offline access, consent the first time, the app's reverse-DNS redirect.
  await page.evaluate(() => { APP_CONFIG.ANDROID_OAUTH_CLIENT_ID = 'test-android.apps.googleusercontent.com'; window.__shell = []; window.__signin = requestGoogleAccessTokenInApp('consent', 'yo@example.com'); });
  await page.waitForFunction(() => window.__shell.some((m) => m.type === 'signIn'));
  const url = new URL((await page.evaluate(() => window.__shell.find((m) => m.type === 'signIn').url)));
  const p = Object.fromEntries(url.searchParams);
  check('sign-in asks Google for a code with PKCE and offline access, back to com.inhouse.learn:/oauth2redirect', p.client_id === 'test-android.apps.googleusercontent.com' && p.response_type === 'code' && p.access_type === 'offline' && p.code_challenge_method === 'S256' && p.code_challenge.length === 43 && p.redirect_uri === 'com.inhouse.learn:/oauth2redirect' && p.prompt === 'consent' && /^android\.p/.test(p.state), p);

  // 2. The shell hands over the code; the page exchanges it with the verifier and keeps the refresh token.
  const first = await page.evaluate(async (state) => { window.inhouseLearnAuth('code=4%2Fcode-from-google&state=' + state + '&scope=openid'); return window.__signin; }, p.state);
  const exchange = tokenCalls[0];
  const challenge = crypto.createHash('sha256').update(exchange.code_verifier).digest('base64url');
  const stored = await page.evaluate(() => localStorage.getItem('inhouse-learn-android-refresh-token'));
  check('the code is exchanged with the matching verifier and the refresh token is kept on the device', first.access_token === 'ya29.first' && exchange.grant_type === 'authorization_code' && exchange.code === '4/code-from-google' && challenge === p.code_challenge && stored === '1//refresh-token', { first, exchange: Object.assign({}, exchange, { code_verifier: '…' }), stored });

  // 3. A wrong state is ignored (another page cannot inject a code).
  const before = tokenCalls.length;
  await page.evaluate(() => window.inhouseLearnAuth('code=evil&state=android.pdeadbeef'));
  await page.waitForTimeout(300);
  check('a code with another state is ignored', tokenCalls.length === before);

  // 4. Expired: silent renewal with the refresh token — no Google window, no sign-in.
  const renewed = await page.evaluate(async () => { window.__shell = []; const r = await requestGoogleAccessTokenInApp('none', ''); return { token: r.access_token, opened: window.__shell.filter((m) => m.type === 'signIn').length, canSilent: canAttemptSilentGoogleAuth() }; });
  const call = tokenCalls[tokenCalls.length - 1];
  check('when the hour is up the app renews the token by itself (refresh token), without opening Google', /^ya29\.renewed/.test(renewed.token) && renewed.opened === 0 && call.grant_type === 'refresh_token' && call.refresh_token === '1//refresh-token' && renewed.canSilent, { renewed, call });

  // 5. Even an interactive request reuses it while the scopes are the same.
  const again = await page.evaluate(async () => { window.__shell = []; const r = await requestGoogleAccessTokenInApp('consent', ''); return { token: r.access_token, opened: window.__shell.filter((m) => m.type === 'signIn').length }; });
  check('«Entrar con Google» again does not open Google while the refresh token works', /^ya29\.renewed/.test(again.token) && again.opened === 0, again);

  // 6. Revoked at Google: the token is dropped and the user is asked once.
  refreshFails = true;
  const revoked = await page.evaluate(async () => { try { await requestGoogleAccessTokenInApp('none', ''); return { ok: true }; } catch (e) { return { ok: false, message: e.message, stored: localStorage.getItem('inhouse-learn-android-refresh-token') }; } });
  check('a revoked refresh token is forgotten (the next sign-in asks Google again)', !revoked.ok && revoked.stored === null, revoked);
  refreshFails = false;

  // 7. «Cerrar sesión» forgets and revokes it.
  await page.evaluate(() => localStorage.setItem('inhouse-learn-android-refresh-token', '1//again'));
  await page.evaluate(() => logoutGoogle());
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => localStorage.getItem('inhouse-learn-android-refresh-token'));
  check('signing out forgets the refresh token and revokes it at Google', out === null && revokes.some((u) => u.includes('1%2F%2Fagain')), { out, revokes });

  console.log('errors', JSON.stringify(errors.filter((e) => !/initScript|accounts\.google|gsi/.test(e))));
  await browser.close();
})();
