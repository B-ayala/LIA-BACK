const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

const SMTP_SECURE_PORT = 465;
const SEND_TIMEOUT_MS = 10_000;

let transporter;

/** Sin MAIL_USER/MAIL_PASS el envío queda desactivado: la solicitud se registra igual. */
const isMailConfigured = () => Boolean(process.env.MAIL_USER && process.env.MAIL_PASS);

const getTransporter = () => {
  if (!transporter) {
    const port = Number(process.env.MAIL_PORT) || SMTP_SECURE_PORT;
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST || 'smtp.gmail.com',
      port,
      secure: port === SMTP_SECURE_PORT,
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
  }
  return transporter;
};

const sender = () => process.env.MAIL_FROM || process.env.MAIL_USER;

/**
 * Envía un mail de texto plano. Nunca lanza: un mail caído no debe tumbar la solicitud
 * del cliente (ya está guardada). El destinatario y el cuerpo no se loguean (PII).
 * @returns {Promise<boolean>} true si el servidor SMTP aceptó el mensaje.
 */
const sendMail = async ({ to, subject, text, replyTo }) => {
  if (!isMailConfigured()) {
    logger.warn('mail_not_configured', { subject });
    return false;
  }
  try {
    await getTransporter().sendMail({ from: sender(), to, subject, text, ...(replyTo ? { replyTo } : {}) });
    return true;
  } catch (error) {
    logger.error('mail_send_failed', { subject, code: error.code, message: error.message });
    return false;
  }
};

module.exports = { sendMail, isMailConfigured };
