const { parse: parseQueryString } = require('node:querystring');
const twilio = require('twilio');

const MENU_MENSAGEM = `Olá! 👋
Sou um bot de testes.

Digite uma opção:
1 - Horário de atendimento
2 - Endereço
3 - Falar com atendente`;

function montarRespostaBot(mensagemTexto) {
  const texto = (mensagemTexto || '').trim().toLowerCase();

  if (['oi', 'olá', 'ola'].includes(texto)) {
    return MENU_MENSAGEM;
  }

  if (texto === '1') {
    return 'Nosso horário é de segunda a sexta, das 08:00 às 18:00.';
  }

  if (texto === '2') {
    return 'Estamos na Rua Exemplo, 123 - Centro.';
  }

  if (texto === '3') {
    return 'Um atendente irá falar com você em breve.';
  }

  return `Não entendi.\n\n${MENU_MENSAGEM}`;
}

function normalizarBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  if (Buffer.isBuffer(req.body)) {
    return parseQueryString(req.body.toString('utf8'));
  }

  if (typeof req.body === 'string') {
    return parseQueryString(req.body);
  }

  return {};
}

module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  // A Twilio envia os dados da mensagem para esta rota via webhook HTTP.
  // No Vercel, esta função serverless ficará disponível em /api/webhook.
  req.body = normalizarBody(req);

  const mensagemRecebida = req.body.Body;

  console.log(req.body.From);
  console.log(req.body.Body);

  // A resposta do webhook precisa ser TwiML, que é o XML que a Twilio entende.
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(montarRespostaBot(mensagemRecebida));

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml.toString());
};
