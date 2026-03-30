const { parse: parseQueryString } = require('node:querystring');
const twilio = require('twilio');
const {
  getAddressMessage,
  getConfirmationChoiceErrorMessage,
  getConversationFallbackMessage,
  getDatePromptMessage,
  getDateValidationMessage,
  getHoursMessage,
  getNameValidationMessage,
  getRegistrationFailureMessage,
  getRequestConfirmationMessage,
  getRequestRegisteredMessage,
  getRestartSchedulingMessage,
  getSchedulingWelcomeMessage,
  getTalkToTeamMessage,
  getTimePromptMessage,
  getTimeValidationMessage,
  getWelcomeMenuMessage,
} = require('../lib/bot/messages');
const {
  normalizeDateInput,
  normalizeNameInput,
  normalizeTimeInput,
} = require('../lib/bot/validation');
const {
  logAppointmentRegistrationFailure,
  registerAppointmentServiceRequest,
} = require('../lib/core/intake');

const SESSION_STEPS = {
  MENU: 'menu',
  AWAITING_NAME: 'awaiting_name',
  AWAITING_DATE: 'awaiting_date',
  AWAITING_TIME: 'awaiting_time',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
};

// Controle simples de estado em memoria por numero de telefone.
// Nesta etapa, o foco e deixar o happy path da demo mais convincente,
// mantendo o bot como canal de entrada para solicitacoes.
// A confirmacao final do agendamento continua acontecendo fora deste bot,
// pela equipe ou pelos fluxos posteriores do ecossistema.
const sessions = {};

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
  return ['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite'].includes(text);
}

function isMenuCommand(text) {
  return ['menu', 'inicio', 'início'].includes(text);
}

function isSchedulingStep(step) {
  return [
    SESSION_STEPS.AWAITING_NAME,
    SESSION_STEPS.AWAITING_DATE,
    SESSION_STEPS.AWAITING_TIME,
    SESSION_STEPS.AWAITING_CONFIRMATION,
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

function closeSession(from) {
  const previousStep = sessions[from] ? sessions[from].step : null;

  delete sessions[from];

  console.log('[session] Sessão finalizada:', {
    from,
    de: previousStep,
    para: null,
  });
}

function startScheduling(from) {
  resetSession(from);
  setSessionStep(from, SESSION_STEPS.AWAITING_NAME);

  return getSchedulingWelcomeMessage();
}

function restartScheduling(from) {
  resetSession(from);
  setSessionStep(from, SESSION_STEPS.AWAITING_NAME);

  return getRestartSchedulingMessage();
}

async function submitAppointmentRequest(from, session) {
  try {
    console.log('[core] Iniciando persistencia oficial da solicitacao:', {
      phone: from,
      name: session.data.name,
      requestedDate: session.data.date,
      requestedTime: session.data.time,
    });

    const registrationResult = await registerAppointmentServiceRequest({
      phone: from,
      name: session.data.name,
      requestedDate: session.data.date,
      requestedTime: session.data.time,
    });

    console.log('[core] Persistencia oficial concluida:', {
      projectId: registrationResult.project.id,
      contactId: registrationResult.contact.id,
      serviceRequestId: registrationResult.serviceRequest.id,
      phone: from,
    });

    const successMessage = getRequestRegisteredMessage(session);
    closeSession(from);

    return successMessage;
  } catch (error) {
    console.error('[core] Erro ao registrar atendimento no core oficial:', error);
    await logAppointmentRegistrationFailure({
      phone: from,
      projectId: error.projectId || null,
      error,
    });
    return getRegistrationFailureMessage();
  }
}

async function handleSchedulingFlow(from, messageText) {
  const session = ensureSession(from);
  const cleanedMessage = String(messageText || '').trim();
  const normalizedMessage = normalizeMessage(messageText);

  if (session.step === SESSION_STEPS.AWAITING_NAME) {
    const nameResult = normalizeNameInput(cleanedMessage);

    if (!nameResult.isValid) {
      return getNameValidationMessage();
    }

    session.data.name = nameResult.value;
    setSessionStep(from, SESSION_STEPS.AWAITING_DATE);
    return getDatePromptMessage(session.data.name);
  }

  if (session.step === SESSION_STEPS.AWAITING_DATE) {
    const dateResult = normalizeDateInput(cleanedMessage);

    if (!dateResult.isValid) {
      return getDateValidationMessage();
    }

    session.data.date = dateResult.value;
    setSessionStep(from, SESSION_STEPS.AWAITING_TIME);
    return getTimePromptMessage();
  }

  if (session.step === SESSION_STEPS.AWAITING_TIME) {
    const timeResult = normalizeTimeInput(cleanedMessage);

    if (!timeResult.isValid) {
      return getTimeValidationMessage();
    }

    session.data.time = timeResult.value;
    setSessionStep(from, SESSION_STEPS.AWAITING_CONFIRMATION);
    return getRequestConfirmationMessage(session);
  }

  if (session.step === SESSION_STEPS.AWAITING_CONFIRMATION) {
    if (['1', 'confirmar', 'sim'].includes(normalizedMessage)) {
      return submitAppointmentRequest(from, session);
    }

    if (['2', 'corrigir'].includes(normalizedMessage)) {
      return restartScheduling(from);
    }

    return getConfirmationChoiceErrorMessage();
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
    return getWelcomeMenuMessage();
  }

  if (currentSession && isSchedulingStep(currentSession.step)) {
    return handleSchedulingFlow(from, mensagemTexto);
  }

  if (textoNormalizado === '1') {
    return startScheduling(from);
  }

  if (textoNormalizado === '2') {
    return getHoursMessage();
  }

  if (textoNormalizado === '3') {
    return getAddressMessage();
  }

  if (textoNormalizado === '4') {
    resetSession(from);
    return getTalkToTeamMessage();
  }

  return getConversationFallbackMessage();
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
