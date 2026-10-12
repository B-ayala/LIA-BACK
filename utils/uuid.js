/**
 * Ids de `ventas` (uuid). Se validan en el borde: un id que no es UUID nunca
 * llega a un `$1::uuid` (Postgres lo rechazaría con 22P02 y terminaría en 500).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

module.exports = { isUuid };
