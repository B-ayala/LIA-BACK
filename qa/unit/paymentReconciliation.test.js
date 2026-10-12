const test = require('node:test');
const assert = require('node:assert/strict');
const { PAYMENT_STATE, classifyPayments, parseOrderIdsFromReference } = require('../../utils/paymentReconciliation');

test('sin pagos en MP no hay nada que esperar', () => {
  assert.equal(classifyPayments([]).state, PAYMENT_STATE.none);
  assert.equal(classifyPayments(undefined).state, PAYMENT_STATE.none);
});

test('un pago aprobado manda sobre cualquier otro', () => {
  const result = classifyPayments([
    { id: 1, status: 'rejected' },
    { id: 2, status: 'pending' },
    { id: 3, status: 'approved' },
  ]);
  assert.equal(result.state, PAYMENT_STATE.approved);
  assert.equal(result.payment.id, 3);
});

test('pending / in_process / authorized retienen el stock', () => {
  for (const status of ['pending', 'in_process', 'authorized']) {
    assert.equal(classifyPayments([{ status }]).state, PAYMENT_STATE.inFlight, status);
  }
});

test('rechazados, cancelados, reembolsados, contracargados y en mediación no retienen', () => {
  // in_mediation es la disputa de un pago ya aprobado, no un pago que pueda acreditarse.
  for (const status of ['rejected', 'cancelled', 'refunded', 'charged_back', 'in_mediation']) {
    assert.equal(classifyPayments([{ status }]).state, PAYMENT_STATE.none, status);
  }
});

test('parsea los ids de la external_reference', () => {
  assert.deepEqual(parseOrderIdsFromReference('a, b,,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseOrderIdsFromReference(null), []);
});

const { decideAction, isPastHoldLimit, MP_INFLIGHT_MAX_HOURS } = require('../../services/staleOrderSweep');

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours) => new Date(Date.now() - hours * HOUR_MS);

test('sweep: pago aprobado se salda aunque la orden esté vencida', () => {
  assert.equal(decideAction({ state: PAYMENT_STATE.approved }, hoursAgo(1)), 'settle');
});

test('sweep: pago en curso o consulta fallida retiene el stock dentro del tope', () => {
  assert.equal(decideAction({ state: PAYMENT_STATE.inFlight }, hoursAgo(2)), 'hold');
  assert.equal(decideAction({ state: PAYMENT_STATE.unknown }, hoursAgo(2)), 'hold');
});

test('sweep: el tope de retención es 24 h (sin medios diferidos)', () => {
  assert.equal(MP_INFLIGHT_MAX_HOURS, 24);
  assert.equal(decideAction({ state: PAYMENT_STATE.inFlight }, hoursAgo(23)), 'hold');
  assert.equal(decideAction({ state: PAYMENT_STATE.inFlight }, hoursAgo(25)), 'expire');
});

test('sweep: pasado el tope se expira igual (un pago en curso no bloquea el stock para siempre)', () => {
  const old = hoursAgo(MP_INFLIGHT_MAX_HOURS + 1);
  assert.equal(isPastHoldLimit(old), true);
  assert.equal(decideAction({ state: PAYMENT_STATE.inFlight }, old), 'expire');
  assert.equal(decideAction({ state: PAYMENT_STATE.unknown }, old), 'expire');
});

test('sweep: sin pagos en MP se expira', () => {
  assert.equal(decideAction({ state: PAYMENT_STATE.none }, hoursAgo(1)), 'expire');
});
