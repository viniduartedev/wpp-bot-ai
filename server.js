require('dotenv').config();

const express = require('express');
const twilio = require('twilio');

const app = express();
const port = process.env.PORT || 3000;

// Middleware necessário para receber dados no formato enviado pelo Twilio via webhook.
app.use(express.urlencoded({ extended: false }));

/**
 * Menu principal do bot.
 */
const MENU_MENSAGEM = `Olá! 👋
Sou um bot de testes.

Digite uma opção:
1 - Horário de atendimento
2 - Endereço
3 - Falar com atendente`;

/**
 * Define a resposta do bot com base na mensagem recebida.
 * @param {string} mensagemTexto - Texto enviado pelo usuário no WhatsApp.
 * @returns {string} Texto de resposta que será enviado ao usuário.
 */
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

  return `Opção inválida. Por favor, escolha uma das opções abaixo:\n\n${MENU_MENSAGEM}`;
}

app.get('/', (req, res) => {
  res.send('Bot WhatsApp rodando');
});

app.post('/webhook', (req, res) => {
  const remetente = req.body.From;
  const mensagemRecebida = req.body.Body;

  // Log para aprendizado e depuração: mostra quem enviou e o conteúdo da mensagem.
  console.log(`Remetente: ${remetente}`);
  console.log(`Mensagem recebida: ${mensagemRecebida}`);

  // O Twilio envia requisições HTTP para este endpoint (webhook).
  // A resposta precisa estar em XML no formato TwiML para o Twilio processar corretamente.
  // Em ambiente local, este endpoint /webhook normalmente é exposto usando ngrok.
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(montarRespostaBot(mensagemRecebida));

  res.type('text/xml');
  res.send(twiml.toString());
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
