const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase } = require('./helpers/harness');

let publishedFollowUp;
let failFollowUpLoad;
installFakeDatabase((sql) => {
  if (!sql.includes('FROM public.site_content')) return undefined;
  if (failFollowUpLoad) throw new Error('db down');
  return { rows: publishedFollowUp === undefined ? [] : [{ value: publishedFollowUp }] };
});

const mailer = require('../services/mailer');
const { notifyWithdrawalReceived } = require('../services/withdrawalNotifications');

const REQUEST = {
  name: 'Ana', email: 'ana@example.test', description: 'Campera negra', orderNumber: 1001,
  code: 'ARR-2026-0001', needsReview: false, receivedAt: '2026-10-28T15:30:00Z',
};
const ENV_KEYS = ['MAIL_USER', 'MAIL_PASS', 'MAIL_NOTIFY_TO', 'WITHDRAWAL_REFUND_TERM'];

describe('mail de arrepentimiento', () => {
  afterEach(() => {
    ENV_KEYS.forEach((key) => { delete process.env[key]; });
    publishedFollowUp = undefined;
    failFollowUpLoad = false;
  });

  test('sin credenciales de mail: no envía y no lanza', async () => {
    assert.equal(await mailer.sendMail({ to: 'a@example.test', subject: 'x', text: 'y' }), false);
  });

  test('manda la constancia con el código al cliente y el aviso al local', async (t) => {
    process.env.MAIL_USER = 'local@example.test';
    const sendMail = t.mock.method(mailer, 'sendMail', async () => true);
    await notifyWithdrawalReceived(REQUEST);
    const sent = sendMail.mock.calls.map((call) => call.arguments[0]);
    assert.equal(sent.length, 2);
    const toClient = sent.find((mail) => mail.to === REQUEST.email);
    assert.ok(toClient.text.includes(REQUEST.code));
    assert.ok(sent.find((mail) => mail.to === 'local@example.test').text.includes('1001'));
  });

  test('NEGATIVO: sin destino del local solo escribe al cliente', async (t) => {
    const sendMail = t.mock.method(mailer, 'sendMail', async () => true);
    await notifyWithdrawalReceived(REQUEST);
    assert.equal(sendMail.mock.calls.length, 1);
  });

  test('el aviso al local marca las solicitudes sin compra coincidente', async (t) => {
    process.env.MAIL_NOTIFY_TO = 'local@example.test';
    const sendMail = t.mock.method(mailer, 'sendMail', async () => true);
    await notifyWithdrawalReceived({ ...REQUEST, needsReview: true });
    const toStore = sendMail.mock.calls.map((call) => call.arguments[0]).find((mail) => mail.to === 'local@example.test');
    assert.ok(toStore.text.includes('revisarla a mano'));
  });

  test('la constancia trae la fecha, cómo sigue la devolución y el plazo de reintegro solo si está definido', async (t) => {
    process.env.MAIL_USER = 'local@example.test';
    const sendMail = t.mock.method(mailer, 'sendMail', async () => true);
    const clientMail = () => sendMail.mock.calls.map((call) => call.arguments[0])
      .filter((mail) => mail.to === REQUEST.email).at(-1);

    await notifyWithdrawalReceived(REQUEST);
    assert.ok(clientMail().text.includes('28 de octubre de 2026'));
    assert.ok(!/costo|flete/i.test(clientMail().text));
    assert.equal(clientMail().replyTo, 'local@example.test');
    assert.ok(!clientMail().text.includes('Plazo del reintegro'));

    process.env.WITHDRAWAL_REFUND_TERM = '10 días hábiles desde que retiramos el producto';
    await notifyWithdrawalReceived(REQUEST);
    assert.ok(clientMail().text.includes('Plazo del reintegro: 10 días hábiles'));
  });

  describe('"Qué sigue" editable desde el panel', () => {
    const sentToClient = async (t) => {
      process.env.MAIL_USER = 'local@example.test';
      const sendMail = t.mock.method(mailer, 'sendMail', async () => true);
      await notifyWithdrawalReceived(REQUEST);
      return sendMail.mock.calls.map((call) => call.arguments[0]).find((mail) => mail.to === REQUEST.email).text;
    };

    test('usa los pasos y el plazo que publicó el admin, y conserva código y fecha', async (t) => {
      publishedFollowUp = { nextSteps: 'Te escribimos en 48 horas.\n\n  Podés cambiarlo por crédito.  ', refundTerm: '5 días hábiles' };
      const text = await sentToClient(t);
      assert.ok(text.includes('- Te escribimos en 48 horas.'));
      assert.ok(text.includes('- Podés cambiarlo por crédito.'));
      assert.ok(text.includes('Plazo del reintegro: 5 días hábiles.'));
      assert.ok(!text.includes('24 horas'));
      assert.ok(text.includes(REQUEST.code) && text.includes('28 de octubre de 2026'));
    });

    test('NEGATIVO: si falla la lectura o el valor es inválido, manda el texto por defecto', async (t) => {
      failFollowUpLoad = true;
      assert.ok((await sentToClient(t)).includes('Dentro de las 24 horas nos ponemos en contacto'));
      failFollowUpLoad = false;
      publishedFollowUp = { nextSteps: 42, refundTerm: ['x'] };
      assert.ok((await sentToClient(t)).includes('Te reintegramos lo que pagaste por el mismo medio de pago'));
    });

    test('limita la cantidad y el largo de los pasos', async (t) => {
      publishedFollowUp = { nextSteps: Array.from({ length: 12 }, (_, i) => `paso${i}`).join('\n') + `\n${'x'.repeat(500)}` };
      const text = await sentToClient(t);
      assert.ok(text.includes('- paso7') && !text.includes('paso8'));
      assert.ok(!text.includes('x'.repeat(301)));
    });
  });
});
