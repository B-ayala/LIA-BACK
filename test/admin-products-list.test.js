const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, installFakeSupabaseAuth, startApp } = require('./helpers/harness');

const ADMIN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.test' };
const USER = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'user@example.test' };
const ROLES = { [ADMIN.id]: 'admin', [USER.id]: 'user' };
const LIST_PATH = '/api/products/admin/list';

const state = { pageRows: [], countTotal: 0, categories: [], failPage: false };

const pool = installFakeDatabase((sql, params) => {
  if (sql.startsWith('SELECT id, role, name FROM public.profiles')) {
    return { rows: [{ id: params[0], role: ROLES[params[0]], name: 'Test' }] };
  }
  if (sql.includes('COUNT(*) OVER()')) {
    if (state.failPage) throw Object.assign(new Error('db down'), { code: '57P01' });
    return { rows: state.pageRows };
  }
  if (sql.includes('SELECT COUNT(*)::int AS total')) return { rows: [{ total: state.countTotal }] };
  if (sql.includes('AS categories')) return { rows: state.categories.map((category_key) => ({ category_key })) };
  return undefined;
});
installFakeSupabaseAuth({ 'admin-token': ADMIN, 'user-token': USER });

let app;
before(async () => {
  app = await startApp([['/api/products', 'routes/productRoutes.js']]);
});
after(() => app.close());
beforeEach(() => {
  Object.assign(state, { pageRows: [], countTotal: 0, categories: [], failPage: false });
  pool.queries.length = 0;
});

const get = (query = '', token = 'admin-token') => fetch(`${app.baseUrl}${LIST_PATH}${query}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

const pageQuery = () => pool.queries.find((query) => query.sql.includes('COUNT(*) OVER()'));
const row = (id, total) => ({ id, name: `P${id}`, price: 10, stock: 3, category: 'Ropa', status: 'active', total_count: total });

describe('GET /api/products/admin/list: acceso', () => {
  test('sin token responde 401 y no toca la base de productos', async () => {
    const response = await get('', null);
    assert.equal(response.status, 401);
    assert.equal(pageQuery(), undefined);
  });

  test('usuario común responde 403', async () => {
    const response = await get('', 'user-token');
    assert.equal(response.status, 403);
    assert.equal(pageQuery(), undefined);
  });

  test('admin: 200, no se cachea y no choca con /:id', async () => {
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

describe('GET /api/products/admin/list: respuesta', () => {
  test('devuelve items, total, paginado y categorías sin total_count en los items', async () => {
    state.pageRows = [row(2, 7), row(1, 7)];
    state.categories = ['Calzado', 'Ropa'];
    const body = await (await get('?page=2&limit=2')).json();

    assert.deepEqual(body, {
      success: true,
      items: [
        { id: 2, name: 'P2', price: 10, stock: 3, category: 'Ropa', status: 'active' },
        { id: 1, name: 'P1', price: 10, stock: 3, category: 'Ropa', status: 'active' },
      ],
      total: 7, page: 2, limit: 2, totalPages: 4, facets: { categories: ['Calzado', 'Ropa'] },
    });
    assert.deepEqual(pageQuery().params, [2, 2]);
  });

  test('defaults: página 1, límite 5, sin filtros ni orden explícito', async () => {
    const body = await (await get()).json();
    assert.equal(body.page, 1);
    assert.equal(body.limit, 5);
    assert.deepEqual(pageQuery().params, [5, 0]);
    assert.match(pageQuery().sql, /ORDER BY created_at DESC, id DESC/);
  });

  test('página fuera de rango: items vacíos pero total real (consulta de conteo aparte)', async () => {
    state.countTotal = 12;
    const body = await (await get('?page=9')).json();
    assert.deepEqual(body.items, []);
    assert.equal(body.total, 12);
    assert.equal(body.totalPages, 3);
  });

  test('sin resultados: total 0 y totalPages 0', async () => {
    const body = await (await get('?q=nada')).json();
    assert.equal(body.total, 0);
    assert.equal(body.totalPages, 0);
  });
});

describe('GET /api/products/admin/list: SQL parametrizado', () => {
  test('q con comodines LIKE y SQL se escapa y viaja como parámetro', async () => {
    const hostile = "50%_\\'; DROP TABLE productos;--";
    await get(`?q=${encodeURIComponent(hostile)}`);
    const { sql, params } = pageQuery();
    assert.equal(params[0], "%50\\%\\_\\\\'; DROP TABLE productos;--%");
    assert.ok(!sql.includes('DROP TABLE'));
    assert.match(sql, /ILIKE \$1 ESCAPE/);
  });

  test('combina categoría, estado y stock con placeholders en orden', async () => {
    await get(`?q=remera&category=${encodeURIComponent('Ropa interior')}&status=inactive&stock=low_stock&limit=10&page=3`);
    const { sql, params } = pageQuery();
    assert.deepEqual(params, ['%remera%', 'Ropa interior', 'inactive', 10, 20]);
    assert.match(sql, /category_key = \$2/);
    assert.match(sql, /status_key = \$3/);
    assert.match(sql, /effective_stock > 0 AND effective_stock <= 5/);
    assert.match(sql, /LIMIT \$4 OFFSET \$5/);
  });

  test('cada stock usa su regla: in_stock > 0, out_of_stock = 0', async () => {
    await get('?stock=in_stock');
    await get('?stock=out_of_stock');
    const sqls = pool.queries.filter((query) => query.sql.includes('COUNT(*) OVER()')).map((query) => query.sql);
    assert.match(sqls[0], /WHERE effective_stock > 0\s/);
    assert.match(sqls[1], /WHERE effective_stock = 0\s/);
  });

  test('cada orden permitido incluye desempate por id', async () => {
    const sorts = ['name_asc', 'name_desc', 'price_asc', 'price_desc', 'stock_asc', 'stock_desc', 'category_asc', 'category_desc'];
    for (const sort of sorts) {
      pool.queries.length = 0;
      const response = await get(`?sort=${sort}`);
      assert.equal(response.status, 200, sort);
      assert.match(pageQuery().sql, /ORDER BY .*, created_at DESC, id DESC/, sort);
    }
  });

  test('valores vacíos equivalen a "sin filtro"', async () => {
    const response = await get('?q=&category=&status=&stock=&sort=&page=&limit=');
    assert.equal(response.status, 200);
    assert.deepEqual(pageQuery().params, [5, 0]);
  });
});

describe('GET /api/products/admin/list: validación estricta', () => {
  const invalid = [
    ['status fuera de la lista', '?status=deleted', 'status'],
    ['stock fuera de la lista', '?stock=lots', 'stock'],
    ['sort fuera de la lista (inyección)', `?sort=${encodeURIComponent('price; DROP TABLE x')}`, 'sort'],
    ['limit mayor al máximo', '?limit=51', 'limit'],
    ['limit cero', '?limit=0', 'limit'],
    ['limit negativo', '?limit=-1', 'limit'],
    ['limit decimal', '?limit=2.5', 'limit'],
    ['page cero', '?page=0', 'page'],
    ['page no numérica', '?page=abc', 'page'],
    ['q demasiado larga', `?q=${'a'.repeat(101)}`, 'q'],
    ['q repetida', '?q=a&q=b', 'q'],
    ['q como objeto', '?q[x]=1', 'q'],
    ['parámetro desconocido', '?foo=bar', 'query'],
  ];

  for (const [name, query, field] of invalid) {
    test(`${name} responde 400 VALIDATION_ERROR sin tocar la base`, async () => {
      const response = await get(query);
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.code, 'VALIDATION_ERROR');
      assert.equal(body.success, false);
      assert.ok(body.details.some((detail) => detail.field === field), JSON.stringify(body.details));
      assert.equal(pageQuery(), undefined);
    });
  }

  test('límite máximo (50) y emojis / acentos en q se aceptan', async () => {
    assert.equal((await get('?limit=50')).status, 200);
    assert.equal((await get(`?q=${encodeURIComponent('camisa ñandú 🧵')}`)).status, 200);
  });
});

describe('GET /api/products/admin/list: fallas', () => {
  test('error de base responde 500 genérico sin detalles internos', async () => {
    state.failPage = true;
    const response = await get();
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('db down'));
  });
});

describe('contrato público intacto', () => {
  test('/api/products/:id sigue validando el id (ruta admin no lo captura)', async () => {
    const response = await fetch(`${app.baseUrl}/api/products/abc`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_PRODUCT_ID');
  });
});
