const mailer = require('./mailer');
const SiteContent = require('../models/SiteContent');
const logger = require('../utils/logger');

const STORE_NAME = 'LIA';
const FOLLOW_UP_KEY = 'withdrawal_followup';
const MAX_STEPS = 8;
const MAX_TEXT_LENGTH = 300;
// Mismo texto que el editor del panel (front: withdrawalFollowUpService.ts).
const DEFAULT_NEXT_STEPS = Object.freeze([
  'Dentro de las 24 horas nos ponemos en contacto para coordinar la devolución del producto.',
  'Te reintegramos lo que pagaste por el mismo medio de pago que usaste.',
]);
const TIME_ZONE = 'America/Argentina/Buenos_Aires';

const formatReceivedAt = (value) => new Date(value).toLocaleString('es-AR', {
  timeZone: TIME_ZONE, dateStyle: 'long', timeStyle: 'short',
});

const storeAddress = () => process.env.MAIL_NOTIFY_TO || process.env.MAIL_USER;

const cleanText = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_TEXT_LENGTH) : '');

const parseSteps = (value) => {
  const lines = typeof value === 'string'
    ? value.split('\n').map(cleanText).filter(Boolean).slice(0, MAX_STEPS)
    : [];
  return lines.length > 0 ? lines : DEFAULT_NEXT_STEPS;
};

/**
 * "Qué sigue" de la constancia: lo que publica el admin en `site_content` o, si no hay nada,
 * el texto por defecto. El plazo de reintegro es un compromiso del negocio: sin definir no se
 * promete ninguno (cae a la variable WITHDRAWAL_REFUND_TERM por compatibilidad).
 */
const normalizeFollowUp = (value) => {
  const published = value && typeof value === 'object' ? value : {};
  const refundTerm = cleanText(published.refundTerm) || cleanText(process.env.WITHDRAWAL_REFUND_TERM);
  return { nextSteps: parseSteps(published.nextSteps), refundTerm };
};

const loadFollowUp = async () => {
  try {
    return normalizeFollowUp(await SiteContent.get(FOLLOW_UP_KEY));
  } catch (error) {
    logger.warn('withdrawal_followup_load_failed', { code: error.code, message: error.message });
    return normalizeFollowUp(null);
  }
};

const clientBody = ({ name, code, orderNumber, receivedAt }, followUp) => [
  `Hola ${name},`,
  '',
  `Recibimos tu solicitud de arrepentimiento el ${formatReceivedAt(receivedAt)}.`,
  '',
  `Tu código de seguimiento es: ${code}`,
  ...(orderNumber ? [`Pedido: N° ${orderNumber}`] : []),
  '',
  'Qué sigue:',
  ...followUp.nextSteps.map((step) => `- ${step}`),
  ...(followUp.refundTerm ? [`- Plazo del reintegro: ${followUp.refundTerm}.`] : []),
  '',
  `Si necesitás consultarnos, respondé este mail${storeAddress() ? ` (${storeAddress()})` : ''} y citá tu código.`,
  '',
  `Equipo ${STORE_NAME}`,
].join('\n');

const optionalLine = (label, value) => (value === undefined ? [] : [`${label}: ${value}`]);

const storeBody = (request) => [
  `Nueva solicitud de arrepentimiento ${request.code}.`,
  request.needsReview
    ? 'ATENCIÓN: no se pudo vincular con una compra con certeza, revisarla a mano.'
    : 'Se vinculó con una compra existente.',
  '',
  `Nombre: ${request.name}`,
  `Email: ${request.email}`,
  ...optionalLine('N° de pedido', request.orderNumber),
  ...optionalLine('Fecha de compra', request.purchaseDate),
  ...optionalLine('Importe', request.purchaseAmount),
  `Detalle: ${request.description}`,
  '',
  'Responder dentro de las 24 horas desde el panel de administración.',
].join('\n');

/**
 * Constancia al cliente (Disp. 954/2025: el código se devuelve por el mismo medio) y aviso
 * interno para que alguien responda a tiempo. Se llama sin `await`: ver `sendMail`.
 */
const notifyWithdrawalReceived = async (request) => {
  const followUp = await loadFollowUp();
  const subjectCode = `Solicitud de arrepentimiento ${request.code}`;
  const store = storeAddress();
  const sends = [mailer.sendMail({
    to: request.email, subject: `${subjectCode} recibida`, text: clientBody(request, followUp), replyTo: store,
  })];
  if (store) {
    sends.push(mailer.sendMail({ to: store, subject: `Nueva ${subjectCode}`, text: storeBody(request) }));
  }
  return Promise.all(sends);
};

module.exports = { notifyWithdrawalReceived, normalizeFollowUp, DEFAULT_NEXT_STEPS };
