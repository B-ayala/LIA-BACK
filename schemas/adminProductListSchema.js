const { z } = require('zod');
const { optionalText, optionalEnum, integerParam } = require('./queryParamHelpers');

/**
 * Query string de `GET /api/products/admin/list` (solo admin).
 *
 * Estricto: un parámetro desconocido, repetido (`?q=a&q=b`) o con forma de objeto
 * (`?q[x]=1`) es 400. Un valor vacío (`?category=`) equivale a "sin filtro", que es lo
 * que manda un formulario con el filtro en "Todas".
 */

const STATUS_VALUES = ['active', 'inactive'];
const STOCK_VALUES = ['in_stock', 'low_stock', 'out_of_stock'];
const SORT_VALUES = [
  'name_asc', 'name_desc', 'price_asc', 'price_desc',
  'stock_asc', 'stock_desc', 'category_asc', 'category_desc',
];

const MAX_SEARCH_LENGTH = 100;
const MAX_CATEGORY_LENGTH = 100;
const MAX_PAGE = 100000;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

const adminProductListQuerySchema = z.object({
  q: optionalText(MAX_SEARCH_LENGTH),
  category: optionalText(MAX_CATEGORY_LENGTH),
  status: optionalEnum(STATUS_VALUES),
  stock: optionalEnum(STOCK_VALUES),
  sort: optionalEnum(SORT_VALUES),
  page: integerParam('page', DEFAULT_PAGE, MAX_PAGE),
  limit: integerParam('limit', DEFAULT_LIMIT, MAX_LIMIT),
}).strict();

module.exports = { adminProductListQuerySchema, STATUS_VALUES, STOCK_VALUES, SORT_VALUES, MAX_LIMIT };
