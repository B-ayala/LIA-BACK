const test = require('node:test');
const assert = require('node:assert/strict');
const OrderPayment = require('../../models/OrderPayment');
const Order = require('../../models/Order');
const logger = require('../../utils/logger');
const {
  settleApprovedPayment, flagReversedPayment, resolveOrderIds, AMOUNT_MISMATCH,
} = require('../../utils/paymentSettlement');
const { mergeOutcomes, cancelMpPurchases, CANCEL_OUTCOME } = require('../../services/mpCancellation');
const { groupStaleOrders, splitFlaggedGroups } = require('../../services/staleOrderSweep');

const ID_A = '3f2b8c1e-9d4a-4b7e-8f00-000000000001';
const ID_B = '3f2b8c1e-9d4a-4b7e-8f00-000000000002';

/** Reemplaza métodos estáticos durante un test y los restaura siempre. */
const stub = (t, target, overrides) => {
  const originals = {};
  for (const [name, fn] of Object.entries(overrides)) {
    originals[name] = target[name];
    target[name] = fn;
  }
  t.after(() => Object.assign(target, originals));
};

const silenceLogs = (t) => stub(t, logger, { error: () => {}, warn: () => {}, info: () => {} });

test('resolveOrderIds: primero por mp_external_reference, si no la lista vieja de ids (solo uuids)', async (t) => {
  const calls = [];
  stub(t, OrderPayment, { findIdsByReference: async (ref) => { calls.push(ref); return ref === 'buy-1' ? [ID_A] : []; } });
  assert.deepEqual(await resolveOrderIds('buy-1'), [ID_A]);
  assert.deepEqual(await resolveOrderIds(`${ID_A},${ID_B},123`), [ID_A, ID_B]);
  assert.deepEqual(await resolveOrderIds(''), []);
  assert.deepEqual(calls, ['buy-1', `${ID_A},${ID_B},123`]);
});

test('settle: monto no numérico → -1, no salda y marca amount_mismatch en las no pagadas', async (t) => {
  silenceLogs(t);
  const reasons = [];
  let marked = false;
  stub(t, OrderPayment, {
    findIdsByReference: async () => [ID_A],
    setReviewReason: async (ids, reason, options) => { reasons.push([ids, reason, options.status]); return 1; },
    markPaidByIds: async () => { marked = true; return 1; },
  });
  const result = await settleApprovedPayment({ id: 9, external_reference: 'buy-1', transaction_amount: 'abc' });
  assert.equal(result, AMOUNT_MISMATCH);
  assert.equal(marked, false);
  assert.deepEqual(reasons, [[[ID_A], 'amount_mismatch', 'unpaid']]);
});

test('settle: monto que no coincide (markPaidByIds -1) también queda amount_mismatch', async (t) => {
  silenceLogs(t);
  const reasons = [];
  stub(t, OrderPayment, {
    findIdsByReference: async () => [ID_A],
    setReviewReason: async (ids, reason) => { reasons.push(reason); return 1; },
    markPaidByIds: async () => AMOUNT_MISMATCH,
  });
  assert.equal(await settleApprovedPayment({ id: 9, external_reference: 'r', transaction_amount: 10 }), AMOUNT_MISMATCH);
  assert.deepEqual(reasons, ['amount_mismatch']);
});

test('settle: devuelve lo que realmente se marcó (0 si ya estaban pagadas)', async (t) => {
  stub(t, OrderPayment, { findIdsByReference: async () => [ID_A], markPaidByIds: async () => 0 });
  assert.equal(await settleApprovedPayment({ id: 9, external_reference: 'r', transaction_amount: 10 }), 0);
});

test('reembolso / contracargo: solo marca ventas pagadas con ese pago, sin tocar estado', async (t) => {
  silenceLogs(t);
  const calls = [];
  stub(t, OrderPayment, {
    findIdsByReference: async () => [ID_A],
    setReviewReason: async (ids, reason, options) => { calls.push({ reason, ...options }); return 1; },
    markPaidByIds: async () => { throw new Error('no debe saldar'); },
  });
  assert.equal(await flagReversedPayment({ id: 7, status: 'refunded', external_reference: 'r' }), 1);
  assert.equal(await flagReversedPayment({ id: 7, status: 'charged_back', external_reference: 'r' }), 1);
  assert.equal(await flagReversedPayment({ id: 7, status: 'rejected', external_reference: 'r' }), 0);
  assert.deepEqual(calls.map((c) => [c.reason, c.status, c.overwrite, c.paymentId]), [
    ['refunded', 'paid', true, 7],
    ['charged_back', 'paid', true, 7],
  ]);
});

test('cancelación: precedencia paid > held > released', () => {
  assert.equal(mergeOutcomes([]), CANCEL_OUTCOME.released);
  assert.equal(mergeOutcomes(['released', 'held']), CANCEL_OUTCOME.held);
  assert.equal(mergeOutcomes(['held', 'paid', 'released']), CANCEL_OUTCOME.paid);
});

test('mp-cancel: si una orden es ajena no se toca nada (forbidden)', async (t) => {
  stub(t, Order, {
    findByIds: async () => [
      { id: ID_A, buyer_email: 'yo@x.com', payment_method: 'mp', payment_status: 'pendiente' },
      { id: ID_B, buyer_email: 'otro@x.com', payment_method: 'mp', payment_status: 'pendiente' },
    ],
    findByIdsForUpdate: async () => { throw new Error('no debe abrir transacción'); },
  });
  const result = await cancelMpPurchases({ email: 'yo@x.com', role: 'user' }, [ID_A, ID_B]);
  assert.deepEqual(result, { forbidden: true });
});

test('mp-cancel: una venta ya pagada hace que el resultado sea paid', async (t) => {
  stub(t, Order, {
    findByIds: async () => [{ id: ID_A, buyer_email: 'yo@x.com', payment_method: 'mp', payment_status: 'pagado' }],
  });
  const result = await cancelMpPurchases({ email: 'YO@x.com', role: 'user' }, [ID_A]);
  assert.deepEqual(result, { forbidden: false, outcome: 'paid' });
});

test('sweep: compras marcadas para revisión no consultan MP y expiran recién pasado el tope', () => {
  const now = Date.now();
  const old = new Date(now - 25 * 60 * 60 * 1000);
  const recent = new Date(now - 60 * 60 * 1000);
  const { legacyIds, groups } = groupStaleOrders([
    { id: ID_A, mp_external_reference: 'flag-old', review_reason: 'amount_mismatch', created_at: old },
    { id: ID_B, mp_external_reference: 'flag-new', review_reason: 'amount_mismatch', created_at: recent },
    { id: 'c', mp_external_reference: 'normal', review_reason: null, created_at: recent },
    { id: 'd', mp_external_reference: null, review_reason: null, created_at: recent },
  ], true);
  assert.deepEqual(legacyIds, ['d']);
  const split = splitFlaggedGroups(groups, now);
  assert.deepEqual(split.lookupReferences, ['normal']);
  assert.deepEqual(split.flaggedExpiredIds, [ID_A]);
  assert.equal(split.flaggedHeld, 1);
});
