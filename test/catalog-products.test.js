const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { installFakeDatabase, startApp } = require('./helpers/harness');

const CATALOG_PATH = '/api/products/catalog';
const DEFAULT_LIMIT = 24;

const state = { pageRows: [], facetRows: [], failPage: false, inFlight: 0, maxInFlight: 0 };

// Cede el turno para que dos consultas lanzadas en paralelo se solapen (y `maxInFlight` lo delate).
const trackConcurrency = async (result) => {
  state.inFlight += 1;
  state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
  await new Promise((resolve) => setImmediate(resolve));
  state.inFlight -= 1;
  return result;
};

const pool = installFakeDatabase((sql) => {
  if (sql.includes('SELECT DISTINCT ON (kind')) return trackConcurrency({ rows: state.facetRows });
  if (sql.includes('COUNT(*) OVER()')) return { rows: [{ id: '1', name: 'P', total_count: 1 }] };
  if (sql.includes('SELECT * FROM public.productos WHERE id = $1')) return { rows: [{ id: '1', name: 'P' }] };
  if (sql.includes('FROM scoped')) {
    if (state.failPage) throw Object.assign(new Error('db down'), { code: '57P01' });
    return trackConcurrency({ rows: state.pageRows });
  }
  return undefined;
});

let app;
before(async () => {
  app = await startApp([['/api/products', 'routes/productRoutes.js']]);
});
after(() => app.close());
beforeEach(() => {
  const { invalidateProducts } = require('../utils/cache');
  invalidateProducts();
  Object.assign(state, { pageRows: [], facetRows: [], failPage: false, inFlight: 0, maxInFlight: 0 });
  pool.queries.length = 0;
});

const get = (query = '', headers = {}) => fetch(`${app.baseUrl}${CATALOG_PATH}${query}`, { headers });
const pageQuery = () => pool.queries.find((query) => query.sql.includes('FROM scoped') && !query.sql.includes('DISTINCT ON (kind'));
const facetsQuery = () => pool.queries.find((query) => query.sql.includes('DISTINCT ON (kind'));
// fetch() agrega `Cache-Control: no-cache` a las condicionales y Express lo trata como "revalidar siempre".
const statusWithEtag = (query, etag) => new Promise((resolve, reject) => {
  http.get(`${app.baseUrl}${CATALOG_PATH}${query}`, { headers: { 'If-None-Match': etag } }, (response) => {
    response.resume();
    resolve(response.statusCode);
  }).on('error', reject);
});
const rows = (count) => Array.from({ length: count }, (_, index) => ({ id: String(count - index), name: `P${index}`, price: 10 }));

describe('GET /api/products/catalog: respuesta', () => {
  test('público: 200 sin token, forma del contrato y caché pública de 10 s sin SWR', async () => {
    state.pageRows = rows(2);
    state.facetRows = [{ kind: 'size', value: 'M' }, { kind: 'color', value: 'Rojo' }];
    const response = await get();
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=10', 'sin stale-while-revalidate');
    assert.deepEqual(Object.keys(body), ['success', 'items', 'hasMore', 'facets']);
    assert.equal(body.items.length, 2);
    assert.equal(body.hasMore, false);
    assert.deepEqual(body.facets, { sizes: ['M'], colors: ['Rojo'] });
  });

  test('defaults: orden newest, offset 0, límite 24 (pide 25 filas para calcular hasMore)', async () => {
    await get();
    const { sql, params } = pageQuery();
    assert.deepEqual(params, [DEFAULT_LIMIT + 1, 0]);
    assert.match(sql, /ORDER BY created_at DESC, id DESC/);
    assert.match(sql, /LIMIT \$1 OFFSET \$2/);
  });

  test('hasMore: llegan limit+1 filas → true y el sobrante no se devuelve', async () => {
    state.pageRows = rows(4);
    const body = await (await get('?limit=3')).json();
    assert.equal(body.hasMore, true);
    assert.equal(body.items.length, 3);
    assert.deepEqual(pageQuery().params, [4, 0]);
  });

  test('hasMore: exactamente limit filas → false', async () => {
    state.pageRows = rows(3);
    const body = await (await get('?limit=3&offset=6')).json();
    assert.equal(body.hasMore, false);
    assert.deepEqual(pageQuery().params, [4, 6]);
  });

  test('sin resultados: items [] , hasMore false y facets vacíos', async () => {
    const body = await (await get('?size=XXL')).json();
    assert.deepEqual(body, { success: true, items: [], hasMore: false, facets: { sizes: [], colors: [] } });
  });

  test('facets ordenados: talles XS<S<M<L, luego numéricos por valor; colores alfabéticos', async () => {
    state.facetRows = ['40', 'L', '8', 'S', 'ÚNICO', 'XS'].map((value) => ({ kind: 'size', value }))
      .concat(['Verde', 'azul', 'Ámbar'].map((value) => ({ kind: 'color', value })));
    const { facets } = await (await get()).json();
    assert.deepEqual(facets.sizes, ['XS', 'S', 'L', '8', '40', 'ÚNICO']);
    assert.deepEqual(facets.colors, ['Ámbar', 'azul', 'Verde']);
  });

  test('el ETag permite 304 sin cuerpo y cambia con el query string', async () => {
    state.pageRows = rows(1);
    const first = await get('?sort=price_asc');
    const etag = first.headers.get('etag');
    assert.ok(etag);
    assert.equal(await statusWithEtag('?sort=price_asc', etag), 304);

    state.pageRows = rows(2);
    invalidateCatalogCache();
    const other = await get('?sort=price_desc');
    assert.notEqual(other.headers.get('etag'), etag);
    assert.equal(await statusWithEtag('?sort=price_desc', etag), 200);
  });
});

const invalidateCatalogCache = () => require('../utils/cache').invalidateProducts();

describe('GET /api/products/catalog: caché del servidor', () => {
  test('dos pedidos iguales ejecutan una sola vez las consultas', async () => {
    await get('?category=Ropa&sort=name_asc');
    await get('?category=Ropa&sort=name_asc');
    assert.equal(pool.queries.filter((query) => query.sql.includes('FROM scoped')).length, 2, 'página + facets una vez');
  });

  test('filtros equivalentes (orden, mayúsculas, repetidos, espacios) comparten entrada', async () => {
    await get('?category=Ropa&category=Calzado');
    await get('?category=calzado&category=%20ropa%20&category=RopA');
    assert.equal(pool.queries.filter((query) => query.sql.includes('FROM scoped')).length, 2);
  });

  test('filtros distintos NO comparten entrada', async () => {
    state.pageRows = rows(1);
    await get('?size=M');
    state.pageRows = rows(2);
    const body = await (await get('?size=L')).json();
    assert.equal(body.items.length, 2);
    // Dos páginas distintas; los facets dependen solo de la categoría y se comparten.
    assert.equal(pool.queries.filter((query) => query.sql.includes('FROM scoped')).length, 3);
  });

  test('invalidateProducts (cambio de stock/producto) vacía el catálogo cacheado', async () => {
    await get('?color=Rojo');
    invalidateCatalogCache();
    await get('?color=Rojo');
    assert.equal(pool.queries.filter((query) => query.sql.includes('FROM scoped')).length, 4);
  });

  test('una falla de base no se cachea: el reintento vuelve a consultar', async () => {
    state.failPage = true;
    assert.equal((await get()).status, 500);
    state.failPage = false;
    assert.equal((await get()).status, 200);
  });
});

describe('GET /api/products/catalog: SQL parametrizado', () => {
  test('solo productos activos, también con un token (jamás identifica a un admin)', async () => {
    await get('', { Authorization: 'Bearer admin-token' });
    assert.match(pageQuery().sql, /WHERE p\.status = 'active'/);
    assert.match(facetsQuery().sql, /WHERE p\.status = 'active'/);
    assert.equal(pool.queries.some((query) => query.sql.includes('public.profiles')), false);
  });

  test('categoría, talle y color viajan como arrays parametrizados, en orden', async () => {
    await get('?category=Remeras&category=Buzos&size=m&color=Rojo&limit=10&offset=20');
    const { sql, params } = pageQuery();
    assert.deepEqual(params, [['Buzos', 'Remeras'], ['m'], ['Rojo'], 11, 20]);
    assert.match(sql, /b\.category_match = ANY\(ARRAY\(SELECT lower\(u\) FROM unnest\(\$1::text\[\]\)/);
    assert.match(sql, /split_part\(c, chr\(31\), 1\) = ANY\(ARRAY\(SELECT upper\(btrim\(u\)\) FROM unnest\(\$2::text\[\]\)/);
    assert.match(sql, /lower\(split_part\(c, chr\(31\), 2\)\) = ANY\(ARRAY\(SELECT lower\(u\) FROM unnest\(\$3::text\[\]\)/);
    assert.match(sql, /LIMIT \$4 OFFSET \$5/);
  });

  test('los facets solo reciben la categoría (no talle ni color)', async () => {
    await get('?category=Remeras&size=M&color=Rojo');
    assert.deepEqual(facetsQuery().params, [['Remeras']]);
  });

  test('texto hostil, comodines, emojis y acentos viajan como valor, nunca en el SQL', async () => {
    const hostile = "x'); DROP TABLE productos;--";
    const response = await get(`?category=${encodeURIComponent(hostile)}&color=${encodeURIComponent('100%_ñandú 🧵')}`);
    assert.equal(response.status, 200);
    const { sql, params } = pageQuery();
    assert.ok(!sql.includes('DROP TABLE') && !sql.includes('ñandú'));
    assert.deepEqual(params[0], [hostile]);
    assert.deepEqual(params[1], ['100%_ñandú 🧵']);
  });

  test('cada orden permitido arma su ORDER BY con desempate por created_at, id', async () => {
    const expected = {
      newest: /ORDER BY created_at DESC, id DESC/,
      price_asc: /ORDER BY sort_price ASC NULLS LAST, created_at DESC, id DESC/,
      price_desc: /ORDER BY sort_price DESC NULLS LAST, created_at DESC, id DESC/,
      name_asc: /ORDER BY name_sort ASC, created_at DESC, id DESC/,
      name_desc: /ORDER BY name_sort DESC, created_at DESC, id DESC/,
    };
    for (const [sort, pattern] of Object.entries(expected)) {
      pool.queries.length = 0;
      invalidateCatalogCache();
      assert.equal((await get(`?sort=${sort}`)).status, 200, sort);
      assert.match(pageQuery().sql, pattern, sort);
    }
  });

  test('el precio de orden es el efectivo (descuento % y original_price tachado)', async () => {
    await get('?sort=price_asc');
    const { sql } = pageQuery();
    assert.match(sql, /original_price > p\.price THEN p\.price/);
    assert.match(sql, /round\(p\.price::numeric \* \(1 - p\.discount::numeric \/ 100\), 2\)/);
  });

  test('selecciona exactamente las 13 columnas del front, con numéricos como número', async () => {
    await get();
    const select = pageQuery().sql.match(/\nSELECT (.*)\n {2}FROM scoped/)[1];
    assert.equal(select,
      'id, name, price::float8 AS price, original_price::float8 AS original_price, '
      + 'transfer_price::float8 AS transfer_price, image_url, images, category, discount::float8 AS discount, '
      + 'stock::float8 AS stock, hover_image_enabled, card_options, variants');
  });

  test('valores vacíos equivalen a "sin filtro"', async () => {
    const response = await get('?category=&size=&color=&sort=&offset=&limit=');
    assert.equal(response.status, 200);
    assert.deepEqual(pageQuery().params, [DEFAULT_LIMIT + 1, 0]);
  });
});

describe('GET /api/products/catalog: validación estricta', () => {
  const tooMany = (name, count) => Array.from({ length: count }, (_, i) => `${name}=v${i}`).join('&');
  const invalid = [
    ['sort fuera de la lista (inyección)', `?sort=${encodeURIComponent('price; DROP TABLE x')}`, 'sort'],
    ['sort de otro endpoint (stock_asc)', '?sort=stock_asc', 'sort'],
    ['sort repetido', '?sort=newest&sort=price_asc', 'sort'],
    ['limit mayor al máximo (49)', '?limit=49', 'limit'],
    ['limit cero', '?limit=0', 'limit'],
    ['limit negativo', '?limit=-1', 'limit'],
    ['limit decimal', '?limit=2.5', 'limit'],
    ['limit repetido', '?limit=5&limit=6', 'limit'],
    ['offset negativo', '?offset=-1', 'offset'],
    ['offset no numérico', '?offset=abc', 'offset'],
    ['offset sobre el tope', '?offset=2401', 'offset'],
    ['category como objeto', '?category[x]=1', 'category.0'],
    ['size como objeto', '?size[a][b]=1', 'size.0'],
    ['category con más de 40 valores', `?${tooMany('category', 41)}`, 'category'],
    ['size con más de 12 valores', `?${tooMany('size', 13)}`, 'size'],
    ['color con más de 12 valores', `?${tooMany('color', 13)}`, 'color'],
    ['category demasiado larga', `?category=${'a'.repeat(101)}`, 'category.0'],
    ['size demasiado largo', `?size=${'a'.repeat(21)}`, 'size.0'],
    ['color con carácter de control', `?color=${encodeURIComponent('Ro\u001fjo')}`, 'color.0'],
    ['parámetro desconocido', '?foo=bar', 'query'],
    ['parámetro de otro endpoint (status)', '?status=inactive', 'query'],
    ['page (del endpoint admin)', '?page=2', 'query'],
  ];

  for (const [name, query, field] of invalid) {
    test(`${name} responde 400 VALIDATION_ERROR sin tocar la base ni cachear`, async () => {
      const response = await get(query);
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.code, 'VALIDATION_ERROR');
      assert.equal(body.success, false);
      assert.ok(body.details.some((detail) => detail.field === field), JSON.stringify(body.details));
      assert.equal(pageQuery(), undefined);
      assert.ok(!/public/.test(response.headers.get('cache-control') || ''));
    });
  }

  test('límites máximos aceptados: limit 48, offset 2400, 40 categorías, 12 talles', async () => {
    assert.equal((await get('?limit=48&offset=2400')).status, 200);
    assert.equal((await get(`?${tooMany('category', 40)}&${tooMany('size', 12)}`)).status, 200);
  });
});

describe('GET /api/products/catalog: fallas y rutas vecinas', () => {
  test('error de base responde 500 genérico sin detalles internos', async () => {
    state.failPage = true;
    const response = await get();
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('db down'));
  });

  test('/catalog no es capturada por /:id y /:id sigue validando el id', async () => {
    assert.equal((await get()).status, 200);
    const response = await fetch(`${app.baseUrl}/api/products/abc`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_PRODUCT_ID');
  });
});

describe('H-01 / S-14: conexiones, cachés del servidor y límites del catálogo', () => {
  test('un miss usa UNA conexión a la vez: página y facets en serie, nunca en paralelo', async () => {
    state.pageRows = rows(2);
    await get('?category=Ropa');
    assert.equal(state.maxInFlight, 1);
    assert.equal(pool.queries.filter((query) => query.sql.includes('FROM scoped')).length, 2);
  });

  test('los facets dependen solo de la categoría: otra página/orden/talle reutiliza los facets', async () => {
    state.facetRows = [{ kind: 'size', value: 'M' }];
    await get('?category=Ropa&sort=price_asc');
    await get('?category=Ropa&sort=name_asc&size=M&offset=24');
    assert.equal(pool.queries.filter((query) => query.sql.includes('DISTINCT ON (kind')).length, 1);
    await get('?category=Calzado');
    assert.equal(pool.queries.filter((query) => query.sql.includes('DISTINCT ON (kind')).length, 2);
  });

  test('los facets tienen un TTL propio, más largo que el de las páginas', () => {
    const { TTL } = require('../utils/cache');
    assert.ok(TTL.catalogFacets > TTL.products);
  });

  test('categorías inventadas (resultados vacíos) no ocupan la caché del catálogo: van a catalogMisses', async () => {
    const { caches } = require('../utils/cache');
    for (let index = 0; index < 20; index += 1) await get(`?category=inventada-${index}`);
    assert.equal(caches.catalog.entries.size, 0);
    assert.ok(caches.catalogMisses.entries.size > 0);
    assert.ok(caches.catalogMisses.entries.size <= caches.catalogMisses.maxEntries);
  });

  test('las cachés del catálogo son LRU: un barrido de claves únicas no expulsa la clave caliente', () => {
    const { caches } = require('../utils/cache');
    for (const cache of [caches.catalog, caches.catalogFacets, caches.catalogMisses]) assert.equal(cache.lru, true, cache.name);

    const { TtlCache } = require('../utils/cache');
    const cache = new TtlCache({ name: 'lru-test', maxEntries: 3, lru: true });
    cache.set('hot', 1, 60000);
    for (let index = 0; index < 10; index += 1) {
      cache.get('hot');
      cache.set(`junk-${index}`, index, 60000);
    }
    assert.equal(cache.get('hot'), 1);
    assert.equal(cache.entries.size, 3);
  });

  test('el offset máximo es 2400 (100 páginas de 24)', async () => {
    const { MAX_OFFSET } = require('../schemas/catalogQuerySchema');
    assert.equal(MAX_OFFSET, 2400);
    assert.equal((await get('?offset=2400')).status, 200);
    assert.equal((await get('?offset=2401')).status, 400);
    assert.equal((await get('?offset=48')).status, 200, 'offset no múltiplo/arbitrario: el front usa filas recibidas');
    assert.equal((await get('?offset=50')).status, 200);
  });

  test('tanda C: /catalog y /:id sin stale-while-revalidate; el listado general queda como estaba', async () => {
    const base = `${app.baseUrl}/api/products`;
    const detail = await fetch(`${base}/1`);
    assert.equal(detail.status, 200);
    assert.equal(detail.headers.get('cache-control'), 'public, max-age=5');
    const list = await fetch(base);
    assert.equal(list.headers.get('cache-control'), 'public, max-age=10, stale-while-revalidate=30');
    assert.equal((await get()).headers.get('cache-control'), 'public, max-age=10');
  });

  test('límite propio de 120/min: se corta con 429 antes del límite general de 600', async () => {
    let blocked = null;
    for (let index = 0; index < 200 && !blocked; index += 1) {
      const response = await get(`?limit=${(index % 40) + 1}`);
      if (response.status === 429) blocked = response;
    }
    assert.ok(blocked, 'debe aparecer un 429');
    assert.equal(blocked.headers.get('x-ratelimit-limit'), '120');
    assert.ok(blocked.headers.get('retry-after'));
    assert.equal((await blocked.json()).code, 'RATE_LIMITED');
  });
});
