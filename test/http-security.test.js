const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { installFakeDatabase, startApp } = require('./helpers/harness');

process.env.NODE_ENV = 'production';
process.env.FRONTEND_URL = 'https://tienda.example.test,https://www.tienda.example.test';

const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
installFakeDatabase((sql) => {
  if (sql.includes('FROM public.profiles p')) {
    return { rows: [{ id: USER_ID, name: 'Test', role: 'user', email: 'user@example.test' }] };
  }
  return undefined;
});

// Doble de fetch hacia Supabase Auth: registra las llamadas y responde según el endpoint.
let supabaseCalls;
let supabaseBehavior;
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const target = String(url);
  if (!target.startsWith('https://supabase.test')) return realFetch(url, options);
  const call = { url: target, method: options.method, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
  supabaseCalls.push(call);
  const { status, json } = supabaseBehavior(call);
  return { ok: status >= 200 && status < 300, status, json: async () => json };
};

const GOOD_TOKENS = { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600, user: { id: USER_ID } };
const defaultBehavior = (call) => {
  if (call.url.includes('grant_type=password')) {
    return call.body.password === 'correcta'
      ? { status: 200, json: GOOD_TOKENS }
      : { status: 400, json: { error_code: 'invalid_credentials' } };
  }
  if (call.url.includes('grant_type=refresh_token')) {
    return call.body.refresh_token === 'refresh-vigente'
      ? { status: 200, json: GOOD_TOKENS }
      : { status: 400, json: { error_code: 'refresh_token_not_found' } };
  }
  if (call.url.includes('/auth/v1/logout')) {
    return call.headers.Authorization === 'Bearer access-new'
      ? { status: 204, json: null }
      : { status: 403, json: { msg: 'expired' } };
  }
  return { status: 200, json: {} };
};

let app;
before(async () => {
  app = await startApp([
    ['/api/auth', 'routes/authRoutes.js'],
    ['/api/users', 'routes/userRoutes.js'],
  ]);
});
after(() => app.close());
beforeEach(() => {
  supabaseCalls = [];
  supabaseBehavior = defaultBehavior;
});

const parseBody = (data) => {
  try { return data ? JSON.parse(data) : null; } catch { return data; }
};

/** fetch no deja forzar `Origin` en todos los runtimes: se usa http directo. */
const rawRequest = (method, path, { headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(app.baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const request = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { 'Content-Type': 'application/json', ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: parseBody(data) }));
      }
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });

const TRUSTED = { Origin: 'https://tienda.example.test' };

describe('CORS y CSRF (prueba G)', () => {
  test('NEGATIVO: un origen fuera de la allowlist no recibe Access-Control-Allow-Origin', async () => {
    const { headers } = await rawRequest('OPTIONS', '/api/auth/login', {
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(headers['access-control-allow-origin'], undefined);
  });

  test('NEGATIVO: en producción localhost NO es un origen aceptado', async () => {
    const { headers } = await rawRequest('OPTIONS', '/api/auth/login', {
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(headers['access-control-allow-origin'], undefined);
  });

  test('POSITIVO: un origen de la allowlist se refleja con credenciales y nunca como comodín', async () => {
    const { headers } = await rawRequest('OPTIONS', '/api/auth/login', {
      headers: { ...TRUSTED, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(headers['access-control-allow-origin'], TRUSTED.Origin);
    assert.equal(headers['access-control-allow-credentials'], 'true');
  });

  for (const path of ['/api/auth/login', '/api/auth/refresh', '/api/auth/logout']) {
    test(`NEGATIVO (CSRF): POST ${path} desde un origen no confiable -> 403 sin llamar a Supabase`, async () => {
      const { status } = await rawRequest('POST', path, {
        headers: { Origin: 'https://evil.example', Cookie: 'sb_refresh_token=refresh-vigente' },
        body: { email: 'user@example.test', password: 'correcta' },
      });
      assert.equal(status, 403);
      assert.equal(supabaseCalls.length, 0);
    });
  }
});

describe('Cabeceras de seguridad de la API', () => {
  test('toda respuesta lleva CSP restrictiva, nosniff, anti-framing y HSTS detrás de HTTPS', async () => {
    const { headers } = await rawRequest('POST', '/api/auth/refresh', { headers: { ...TRUSTED, 'X-Forwarded-Proto': 'https' } });
    assert.match(headers['content-security-policy'], /default-src 'none'/);
    assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.match(headers['strict-transport-security'], /max-age=31536000/);
    assert.equal(headers['x-powered-by'], undefined);
    assert.equal(headers['cache-control'], 'no-store');
  });
});

describe('Sesión: cookie, refresh y revocación (pruebas A y 15)', () => {
  test('POSITIVO: el login deja el refresh token en cookie HttpOnly+Secure+SameSite=None y NO lo devuelve en el body', async () => {
    const { status, headers, body } = await rawRequest('POST', '/api/auth/login', {
      headers: TRUSTED,
      body: { email: 'user@example.test', password: 'correcta' },
    });
    assert.equal(status, 200);
    const cookie = [].concat(headers['set-cookie']).join(';');
    assert.match(cookie, /sb_refresh_token=refresh-new/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=None/i);
    assert.match(cookie, /Path=\/api\/auth/i);
    assert.equal(JSON.stringify(body).includes('refresh-new'), false);
  });

  test('NEGATIVO: credenciales inválidas -> 401 genérico, sin cookie y sin distinguir cuenta inexistente', async () => {
    const wrongPassword = await rawRequest('POST', '/api/auth/login', { headers: TRUSTED, body: { email: 'existe@example.test', password: 'mala' } });
    const unknownUser = await rawRequest('POST', '/api/auth/login', { headers: TRUSTED, body: { email: 'noexiste@example.test', password: 'mala' } });
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.body, unknownUser.body);
    assert.equal(wrongPassword.headers['set-cookie'], undefined);
  });

  test('NEGATIVO: refresh sin cookie -> 401 y sin llamar a Supabase', async () => {
    const { status } = await rawRequest('POST', '/api/auth/refresh', { headers: TRUSTED });
    assert.equal(status, 401);
    assert.equal(supabaseCalls.length, 0);
  });

  test('NEGATIVO: refresh con token revocado -> 401 y se borra la cookie', async () => {
    const { status, headers } = await rawRequest('POST', '/api/auth/refresh', { headers: { ...TRUSTED, Cookie: 'sb_refresh_token=refresh-revocado' } });
    assert.equal(status, 401);
    assert.match([].concat(headers['set-cookie']).join(';'), /sb_refresh_token=;/);
  });

  test('NEGATIVO: logout con el access token VENCIDO igual revoca la sesión usando la cookie de refresh', async () => {
    const { status } = await rawRequest('POST', '/api/auth/logout', {
      headers: { ...TRUSTED, Authorization: 'Bearer access-vencido', Cookie: 'sb_refresh_token=refresh-vigente' },
    });
    assert.equal(status, 200);
    const logouts = supabaseCalls.filter((c) => c.url.includes('/auth/v1/logout'));
    assert.equal(logouts.length, 2, 'primer intento con el access vencido (403) y segundo con uno renovado');
    assert.equal(logouts[1].headers.Authorization, 'Bearer access-new');
    assert.match(logouts[1].url, /scope=global/);
  });

  test('POSITIVO: logout con access token vigente revoca globalmente en una sola llamada', async () => {
    supabaseBehavior = () => ({ status: 204, json: null });
    const { status, headers } = await rawRequest('POST', '/api/auth/logout', { headers: { ...TRUSTED, Authorization: 'Bearer access-new' } });
    assert.equal(status, 200);
    assert.equal(supabaseCalls.filter((c) => c.url.includes('/auth/v1/logout')).length, 1);
    assert.match([].concat(headers['set-cookie']).join(';'), /sb_refresh_token=;/);
  });

  test('NEGATIVO: logout sin ninguna credencial no llama a Supabase', async () => {
    const { status } = await rawRequest('POST', '/api/auth/logout', { headers: TRUSTED });
    assert.equal(status, 200);
    assert.equal(supabaseCalls.length, 0);
  });
});

describe('Recuperación de contraseña y enumeración de usuarios', () => {
  test('NEGATIVO: forgot-password responde igual exista o no la cuenta', async () => {
    supabaseBehavior = (call) => (call.body.email.startsWith('existe')
      ? { status: 200, json: {} }
      : { status: 400, json: { msg: 'user not found' } });
    const existing = await rawRequest('POST', '/api/auth/forgot-password', { body: { email: 'existe@example.test' } });
    const unknown = await rawRequest('POST', '/api/auth/forgot-password', { body: { email: 'noexiste@example.test' } });
    assert.equal(existing.status, 200);
    assert.deepEqual(existing.body, unknown.body);
  });

  test('NEGATIVO: el cuarto pedido para el mismo email en 24h se bloquea (límite por cuenta)', async () => {
    const email = 'victima@example.test';
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await rawRequest('POST', '/api/auth/forgot-password', { body: { email } })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });

  test('NEGATIVO: el redirect_to del mail sale de la configuración, no del request', async () => {
    await rawRequest('POST', '/api/auth/forgot-password', {
      headers: { Origin: 'https://evil.example', Host: 'evil.example' },
      body: { email: 'otra@example.test', redirectTo: 'https://evil.example', redirect_to: 'https://evil.example' },
    });
    const recover = supabaseCalls.find((c) => c.url.includes('/auth/v1/recover'));
    assert.ok(recover);
    assert.ok(decodeURIComponent(recover.url).includes('redirect_to=https://tienda.example.test/auth/reset-password'));
    assert.equal(JSON.stringify(recover.body).includes('evil.example'), false);
  });
});

describe('Rate limiting y fuerza bruta (prueba 12)', () => {
  test('NEGATIVO: el login se corta con 429 al superar el límite por IP, y /users/login comparte ese cupo', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await rawRequest('POST', '/api/auth/login', { headers: { ...TRUSTED, 'X-Forwarded-For': '198.51.100.7' }, body: { email: `a${i}@example.test`, password: 'mala' } })).status);
    }
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await rawRequest('POST', '/api/users/login', { headers: { 'X-Forwarded-For': '198.51.100.7' }, body: { email: `b${i}@example.test`, password: 'mala' } })).status);
    }
    assert.equal(statuses.filter((s) => s === 429).length, 2, `12 intentos entre ambos endpoints -> 2 bloqueados (obtenido: ${statuses.join(',')})`);
    assert.equal(statuses.indexOf(429), 10);
  });

  test('NEGATIVO: la misma cuenta se bloquea con backoff tras varios fallos aunque cambie la IP', async () => {
    const email = 'objetivo@example.test';
    const last = [];
    for (let i = 0; i < 5; i += 1) {
      const { status } = await rawRequest('POST', '/api/users/login', { headers: { 'X-Forwarded-For': `10.0.0.${i}` }, body: { email, password: 'mala' } });
      last.push(status);
    }
    assert.ok(last.includes(429), `esperaba un bloqueo por cuenta, obtuvo ${last.join(',')}`);
  });
});
