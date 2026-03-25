const { parse: parseQueryString } = require('node:querystring');
const twilio = require('twilio');
const { saveAppointmentRequest } = require('../lib/appointment-requests');

const SESSION_STEPS = {
  MENU: 'menu',
  AWAITING_NAME: 'awaiting_name',
  AWAITING_DATE: 'awaiting_date',
  AWAITING_TIME: 'awaiting_time',
  CONFIRMED: 'confirmed',
};

// Controle simples de estado em memoria por numero de telefone.
// Isso serve para aprendizado e pode funcionar enquanto a mesma funcao
// serverless continuar "quente" no provedor.
// Em producao isso nao e confiavel em serverless, porque a memoria pode
// ser perdida entre invocacoes. O ideal no futuro e usar banco de dados
// ou um cache externo para persistir o estado da conversa.
// Neste MVP, o Firestore entra para persistir apenas a solicitacao final
// de agendamento, que depois pode ser lida pelo painel em outro projeto.
const sessions = {};

function getMainMenu() {
  return `Olá! 👋
Sou um bot de testes.

Digite uma opção:
1 - Horário de atendimento
2 - Endereço
3 - Falar com atendente
4 - Agendar consulta`;
}

function createInitialSession() {
  return {
    step: SESSION_STEPS.MENU,
    data: {
      name: '',
      date: '',
      time: '',
    },
  };
}

function normalizeMessage(message) {
  return String(message || '').trim().toLowerCase();
}

function isGreeting(text) {
  return ['oi', 'olá', 'ola'].includes(text);
}

function isMenuCommand(text) {
  return text === 'menu';
}

function isSchedulingStep(step) {
  return [
    SESSION_STEPS.AWAITING_NAME,
    SESSION_STEPS.AWAITING_DATE,
    SESSION_STEPS.AWAITING_TIME,
  ].includes(step);
}

function logCurrentSession(from) {
  if (!sessions[from]) {
    console.log('[session] Estado atual: nenhuma sessão ativa');
    return;
  }

  console.log('[session] Estado atual:', {
    from,
    step: sessions[from].step,
    data: sessions[from].data,
  });
}

function ensureSession(from) {
  if (!sessions[from]) {
    sessions[from] = createInitialSession();
    console.log('[session] Sessão criada:', {
      from,
      step: sessions[from].step,
    });
  }

  return sessions[from];
}

function setSessionStep(from, nextStep) {
  const session = ensureSession(from);
  const previousStep = session.step;

  session.step = nextStep;

  console.log('[session] Mudança de etapa:', {
    from,
    de: previousStep,
    para: nextStep,
  });

  return session;
}

function resetSession(from) {
  const previousStep = sessions[from] ? sessions[from].step : null;

  sessions[from] = createInitialSession();

  console.log('[session] Sessão resetada:', {
    from,
    de: previousStep,
    para: sessions[from].step,
  });

  return sessions[from];
}

function buildConfirmationMessage(session) {
  return `Agendamento solicitado com sucesso ✅

Nome: ${session.data.name}
Data: ${session.data.date}
Horário: ${session.data.time}

Em breve entraremos em contato para confirmar.

Digite menu para voltar ao início.`;
}

async function handleSchedulingFlow(from, messageText) {
  const session = ensureSession(from);
  const cleanedMessage = String(messageText || '').trim();

  if (session.step === SESSION_STEPS.AWAITING_NAME) {
    session.data.name = cleanedMessage;
    setSessionStep(from, SESSION_STEPS.AWAITING_DATE);
    return `Prazer, ${session.data.name}.
Qual dia você deseja? Exemplo: 25/03`;
  }

  if (session.step === SESSION_STEPS.AWAITING_DATE) {
    session.data.date = cleanedMessage;
    setSessionStep(from, SESSION_STEPS.AWAITING_TIME);
    return 'Qual horário você deseja? Exemplo: 14:00';
  }

  if (session.step === SESSION_STEPS.AWAITING_TIME) {
    session.data.time = cleanedMessage;

    try {
      console.log('[firestore] Iniciando persistencia da solicitacao:', {
        phone: from,
        customerName: session.data.name,
        requestedDate: session.data.date,
        requestedTime: session.data.time,
      });

      const savedRequest = await saveAppointmentRequest({
        phone: from,
        customerName: session.data.name,
        requestedDate: session.data.date,
        requestedTime: session.data.time,
      });

      console.log('[firestore] Solicitacao salva com sucesso:', {
        id: savedRequest.id,
        phone: from,
      });

      setSessionStep(from, SESSION_STEPS.CONFIRMED);
      return buildConfirmationMessage(session);
    } catch (error) {
      console.error('[firestore] Erro ao salvar solicitacao:', error);
      return 'Houve um problema ao registrar seu agendamento. Tente novamente em instantes.';
    }
  }

  return null;
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

async function montarRespostaBot(from, mensagemTexto) {
  const textoNormalizado = normalizeMessage(mensagemTexto);
  const currentSession = sessions[from];

  if (isMenuCommand(textoNormalizado) || isGreeting(textoNormalizado)) {
    resetSession(from);
    return getMainMenu();
  }

  if (currentSession && isSchedulingStep(currentSession.step)) {
    return handleSchedulingFlow(from, mensagemTexto);
  }

  if (textoNormalizado === '1') {
    return 'Nosso horário é de segunda a sexta, das 08:00 às 18:00.';
  }

  if (textoNormalizado === '2') {
    return 'Estamos na Rua Exemplo, 123 - Centro.';
  }

  if (textoNormalizado === '3') {
    return 'Um atendente irá falar com você em breve.';
  }

  if (textoNormalizado === '4') {
    resetSession(from);
    setSessionStep(from, SESSION_STEPS.AWAITING_NAME);
    return 'Perfeito! Vamos iniciar seu agendamento.\n\nQual é o seu nome?';
  }

  if (currentSession && currentSession.step === SESSION_STEPS.CONFIRMED) {
    return 'Seu agendamento já foi registrado. Digite menu para voltar ao início.';
  }

  return "Não entendi sua mensagem. Digite 'menu' para ver as opções.";
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  // Webhook e a URL HTTP que a Twilio chama automaticamente
  // sempre que uma nova mensagem chega no WhatsApp Sandbox.
  // No Vercel, esta funcao serverless continua exposta em /api/webhook.
  req.body = normalizarBody(req);

  const from = req.body.From || 'unknown';
  const mensagemRecebida = req.body.Body || '';

  console.log('[webhook] Número do remetente:', from);
  console.log('[webhook] Mensagem recebida:', mensagemRecebida);
  logCurrentSession(from);

  // TwiML e o XML que a Twilio entende como instrucao de resposta.
  // Aqui usamos a biblioteca oficial para montar a resposta do WhatsApp.
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(await montarRespostaBot(from, mensagemRecebida));

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml.toString());
};
