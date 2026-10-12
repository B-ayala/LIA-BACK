/**
 * Motivos por los que una venta queda marcada para revisión del admin
 * (`ventas.review_reason`). Solo los escribe el backend; el front los muestra.
 */
const REVIEW_REASON = Object.freeze({
  amountMismatch: 'amount_mismatch',
  duplicatePayment: 'duplicate_payment',
  refunded: 'refunded',
  chargedBack: 'charged_back',
});

/** Estado de un pago de MP que revierte un cobro → motivo de revisión. */
const REVERSED_PAYMENT_REASON = Object.freeze({
  refunded: REVIEW_REASON.refunded,
  charged_back: REVIEW_REASON.chargedBack,
});

module.exports = { REVIEW_REASON, REVERSED_PAYMENT_REASON };
