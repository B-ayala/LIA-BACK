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

test('pending / in_process / authorized / in_mediation retienen el stock', () => {
  for (const status of ['pending', 'in_process', 'authorized', 'in_mediation']) {
    assert.equal(classifyPayments([{ status }]).state, PAYMENT_STATE.inFlight, status);
  }
});

test('rechazados, cancelados, reembolsados y contracargados no retienen', () => {
  for (const status of ['rejected', 'cancelled', 'refunded', 'charged_back']) {
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

test('sweep: pasado el tope se expira igual (un ticket no bloquea el stock para siempre)', () => {
  const old = hoursAgo(MP_INFLIGHT_MAX_HOURS + 1);
  assert.equal(isPastHoldLimit(old), true);
  assert.equal(decideAction({ state: PAYMENT_STATE.inFlight }, old), 'expire');
  assert.equal(decideAction({ state: PAYMENT_STATE.unknown }, old), 'expire');
});

test('sweep: sin pagos en MP se expira', () => {
  assert.equal(decideAction({ state: PAYMENT_STATE.none }, hoursAgo(1)), 'expire');
});
