const mailer = require('./mailer');

const STORE_NAME = 'LIA';
const TIME_ZONE = 'America/Argentina/Buenos_Aires';

const formatReceivedAt = (value) => new Date(value).toLocaleString('es-AR', {
  timeZone: TIME_ZONE, dateStyle: 'long', timeStyle: 'short',
});

const storeAddress = () => process.env.MAIL_NOTIFY_TO || process.env.MAIL_USER;

// Plazo que el negocio se compromete a cumplir; sin definir no se promete ninguno.
const refundLine = () => {
  const term = (process.env.WITHDRAWAL_REFUND_TERM || '').trim();
  return term ? `Plazo del reintegro: ${term}.` : null;
};

const clientBody = ({ name, code, orderNumber, receivedAt }) => [
  `Hola ${name},`,
  '',
  `Recibimos tu solicitud de arrepentimiento el ${formatReceivedAt(receivedAt)}.`,
  '',
  `Tu código de seguimiento es: ${code}`,
  ...(orderNumber ? [`Pedido: N° ${orderNumber}`] : []),
  '',
  'Qué sigue:',
  '- Dentro de las 24 horas nos ponemos en contacto para coordinar la devolución del producto.',
  '- Te reintegramos lo que pagaste por el mismo medio de pago que usaste.',
  ...(refundLine() ? [`- ${refundLine()}`] : []),
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
const notifyWithdrawalReceived = (request) => {
  const subjectCode = `Solicitud de arrepentimiento ${request.code}`;
  const store = storeAddress();
  const sends = [mailer.sendMail({
    to: request.email, subject: `${subjectCode} recibida`, text: clientBody(request), replyTo: store,
  })];
  if (store) {
    sends.push(mailer.sendMail({ to: store, subject: `Nueva ${subjectCode}`, text: storeBody(request) }));
  }
  return Promise.all(sends);
};

module.exports = { notifyWithdrawalReceived };
