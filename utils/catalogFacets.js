/**
 * Facets del catálogo (talles y colores disponibles) a partir de las filas `{ kind, value }` que
 * devuelve `buildCatalogFacetsQuery`. El orden se resuelve acá y no en SQL: los talles tienen un
 * orden de negocio (XS < S < M…, y los numéricos por valor) que ninguna colación da.
 */

const LETTER_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const NUMERIC_SIZE = /^\d+(?:[.,]\d+)?$/;
const RANK = { letter: 0, numeric: 1, other: 2 };

const sizeRank = (size) => {
  const letterIndex = LETTER_SIZES.indexOf(size);
  if (letterIndex >= 0) return [RANK.letter, letterIndex, size];
  if (NUMERIC_SIZE.test(size)) return [RANK.numeric, Number(size.replace(',', '.')), size];
  return [RANK.other, 0, size];
};

const compareSizes = (a, b) => {
  const [groupA, orderA, textA] = sizeRank(a);
  const [groupB, orderB, textB] = sizeRank(b);
  if (groupA !== groupB) return groupA - groupB;
  if (orderA !== orderB) return orderA - orderB;
  return textA < textB ? -1 : Number(textA > textB);
};

const compareColors = (a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' });

/** @returns {{sizes: string[], colors: string[]}} */
const buildFacets = (rows) => ({
  sizes: rows.filter((row) => row.kind === 'size').map((row) => row.value).sort(compareSizes),
  colors: rows.filter((row) => row.kind === 'color').map((row) => row.value).sort(compareColors),
});

module.exports = { buildFacets, compareSizes };
