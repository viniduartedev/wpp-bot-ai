const { parse: parseQueryString } = require('node:querystring');
const twilio = require('twilio');
const {
  getAddressMessage,
  getChannelUnavailableMessage,
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
  buildEffectiveBotProfile,
  resolveMenuOptionKey,
} = require('../lib/bot/profile');
const { handleDevCommand } = require('../lib/dev/commands');
const {
  clearSessionProjectOverride,
  getSessionProjectOverride,
  setSessionProjectOverride,
} = require('../lib/dev/projectOverride');
const {
  normalizeDateInput,
  normalizeNameInput,
  normalizeTimeInput,
} = require('../lib/bot/validation');
const {
  logBotProfileResolutionFailure,
  logProjectRoutingFailure,
  logAppointmentRegistrationFailure,
  registerAppointmentServiceRequest,
} = require('../lib/core/intake');
const {
  getBotProfileByProject,
  isBotProfileInactive,
} = require('../lib/core/botProfiles');
const { resolveProjectForConversation } = require('../lib/routing/resolveProject');

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
// Como o bot agora e multi-tenant por numero de destino, a sessao fica
// isolada por origem + canal recebido, evitando mistura entre projetos.
const sessions = {};

function normalizeSessionIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function buildSessionKey(from, to) {
  return `${normalizeSessionIdentifier(from)}::${normalizeSessionIdentifier(to)}`;
}

function buildSessionContext(from, routingContext) {
  return {
    from: String(from || '').trim(),
    to: routingContext?.to || null,
    projectId: routingContext?.project?.id || null,
    connectionId: routingContext?.connection?.id || null,
    connectionIdentifier: routingContext?.connection?.identifier || routingContext?.to || null,
    botProfile: routingContext?.botProfile || null,
    botProfileId: routingContext?.botProfile?.id || null,
    botProfileFallbackUsed: routingContext?.botProfile?.fallbackUsed || false,
    botProfileSource: routingContext?.botProfile?.source || null,
    routingSource: routingContext?.routingSource || null,
    devMode: routingContext?.devMode || false,
    projectOverrideUsed: routingContext?.projectOverrideUsed || false,
  };
}

function createInitialSession(context = {}, projectOverride = null) {
  return {
    step: SESSION_STEPS.MENU,
    data: {
      name: '',
      date: '',
      time: '',
    },
    projectOverride: projectOverride || null,
    context: {
      from: context.from || '',
      to: context.to || null,
      projectId: context.projectId || null,
      connectionId: context.connectionId || null,
      connectionIdentifier: context.connectionIdentifier || null,
      botProfile: context.botProfile || null,
      botProfileId: context.botProfileId || null,
      botProfileFallbackUsed: context.botProfileFallbackUsed || false,
      botProfileSource: context.botProfileSource || null,
      routingSource: context.routingSource || null,
      devMode: context.devMode || false,
      projectOverrideUsed: context.projectOverrideUsed || false,
    },
  };
}

function normalizeMessage(message) {
  return String(message || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function isGreeting(text) {
  return ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite'].includes(text);
}

function isMenuCommand(text) {
  return ['menu', 'inicio', 'comecar'].includes(text);
}

function isSchedulingStep(step) {
  return [
    SESSION_STEPS.AWAITING_NAME,
    SESSION_STEPS.AWAITING_DATE,
    SESSION_STEPS.AWAITING_TIME,
    SESSION_STEPS.AWAITING_CONFIRMATION,
  ].includes(step);
}

function logCurrentSession(sessionKey) {
  if (!sessions[sessionKey]) {
    console.log('[session] Estado atual: nenhuma sessão ativa', { sessionKey });
    return;
  }

  console.log('[session] Estado atual:', {
    sessionKey,
    step: sessions[sessionKey].step,
    data: sessions[sessionKey].data,
    projectOverride: sessions[sessionKey].projectOverride || null,
    context: sessions[sessionKey].context,
  });
}

function ensureSession(sessionKey, context = {}) {
  if (!sessions[sessionKey]) {
    sessions[sessionKey] = createInitialSession(context);
    console.log('[session] Sessão criada:', {
      sessionKey,
      step: sessions[sessionKey].step,
      projectOverride: sessions[sessionKey].projectOverride || null,
      context: sessions[sessionKey].context,
    });
  } else if (Object.keys(context).length > 0) {
    sessions[sessionKey].context = {
      ...sessions[sessionKey].context,
      ...context,
    };
  }

  return sessions[sessionKey];
}

function setSessionStep(sessionKey, nextStep) {
  const session = ensureSession(sessionKey);
  const previousStep = session.step;

  session.step = nextStep;

  console.log('[session] Mudança de etapa:', {
    sessionKey,
    de: previousStep,
    para: nextStep,
    projectOverride: session.projectOverride || null,
    context: session.context,
  });

  return session;
}

function resetSession(sessionKey, context = {}, options = {}) {
  const previousSession = sessions[sessionKey] || null;
  const previousStep = previousSession ? previousSession.step : null;
  const shouldPreserveProjectOverride = options.preserveProjectOverride !== false;
  const projectOverride = shouldPreserveProjectOverride
    ? getSessionProjectOverride(previousSession)
    : null;

  sessions[sessionKey] = createInitialSession(context, projectOverride);

  console.log('[session] Sessão resetada:', {
    sessionKey,
    de: previousStep,
    para: sessions[sessionKey].step,
    projectOverride: sessions[sessionKey].projectOverride || null,
    context: sessions[sessionKey].context,
  });

  return sessions[sessionKey];
}

function closeSession(sessionKey, context = {}) {
  const previousSession = sessions[sessionKey] || null;
  const previousStep = previousSession ? previousSession.step : null;
  const projectOverride = getSessionProjectOverride(previousSession);

  if (projectOverride) {
    sessions[sessionKey] = createInitialSession(
      {
        ...(previousSession?.context || {}),
        ...context,
      },
      projectOverride,
    );

    console.log('[session] Sessão finalizada com override preservado:', {
      sessionKey,
      de: previousStep,
      para: sessions[sessionKey].step,
      projectOverride,
    });

    return sessions[sessionKey];
  }

  delete sessions[sessionKey];

  console.log('[session] Sessão finalizada:', {
    sessionKey,
    de: previousStep,
    para: null,
  });
}

function startScheduling(sessionKey, context) {
  resetSession(sessionKey, context);
  setSessionStep(sessionKey, SESSION_STEPS.AWAITING_NAME);

  return getSchedulingWelcomeMessage(context.botProfile || null);
}

function restartScheduling(sessionKey, context) {
  resetSession(sessionKey, context);
  setSessionStep(sessionKey, SESSION_STEPS.AWAITING_NAME);

  return getRestartSchedulingMessage(context.botProfile || null);
}

async function submitAppointmentRequest(sessionKey, from, session, routingContext) {
  try {
    console.log('[core] Iniciando persistencia oficial da solicitacao:', {
      phone: from,
      to: routingContext.to,
      projectId: routingContext.project.id,
      connectionId: routingContext.connection?.id || null,
      routingSource: routingContext.routingSource || null,
      devMode: routingContext.devMode || false,
      projectOverrideUsed: routingContext.projectOverrideUsed || false,
      botProfileId: routingContext.botProfile?.id || null,
      botProfileFallbackUsed: routingContext.botProfile?.fallbackUsed || false,
      name: session.data.name,
      requestedDate: session.data.date,
      requestedTime: session.data.time,
    });

    const registrationResult = await registerAppointmentServiceRequest({
      phone: from,
      name: session.data.name,
      requestedDate: session.data.date,
      requestedTime: session.data.time,
      routingContext,
    });

    console.log('[core] Persistencia oficial concluida:', {
      projectId: registrationResult.project.id,
      connectionId: routingContext.connection?.id || null,
      contactId: registrationResult.contact.id,
      serviceRequestId: registrationResult.serviceRequest.id,
      phone: from,
      to: routingContext.to,
      botProfileId: routingContext.botProfile?.id || null,
    });

    const successMessage = getRequestRegisteredMessage(routingContext.botProfile, session);
    closeSession(sessionKey, buildSessionContext(from, routingContext));

    return successMessage;
  } catch (error) {
    console.error('[core] Erro ao registrar atendimento no core oficial:', {
      message: error.message,
      code: error.code || null,
      projectId: error.projectId || routingContext.project?.id || null,
      connectionId: error.connectionId || routingContext.connection?.id || null,
      phone: from,
      to: error.to || routingContext.to || null,
    });
    await logAppointmentRegistrationFailure({
      phone: from,
      projectId: error.projectId || routingContext.project?.id || null,
      error,
      metadata: {
        to: error.to || routingContext.to || null,
        connectionId: error.connectionId || routingContext.connection?.id || null,
        connectionIdentifier:
          routingContext.connection?.identifier || routingContext.to || null,
        botProfileId: routingContext.botProfile?.id || null,
        botProfileFallbackUsed: routingContext.botProfile?.fallbackUsed || false,
      },
    });
    return getRegistrationFailureMessage(routingContext.botProfile);
  }
}

async function handleSchedulingFlow(sessionKey, from, routingContext, messageText) {
  const session = ensureSession(sessionKey, buildSessionContext(from, routingContext));
  const cleanedMessage = String(messageText || '').trim();
  const normalizedMessage = normalizeMessage(messageText);

  if (session.step === SESSION_STEPS.AWAITING_NAME) {
    const nameResult = normalizeNameInput(cleanedMessage);

    if (!nameResult.isValid) {
      return getNameValidationMessage();
    }

    session.data.name = nameResult.value;
    setSessionStep(sessionKey, SESSION_STEPS.AWAITING_DATE);
    return getDatePromptMessage(routingContext.botProfile, session.data.name);
  }

  if (session.step === SESSION_STEPS.AWAITING_DATE) {
    const dateResult = normalizeDateInput(cleanedMessage);

    if (!dateResult.isValid) {
      return getDateValidationMessage();
    }

    session.data.date = dateResult.value;
    setSessionStep(sessionKey, SESSION_STEPS.AWAITING_TIME);
    return getTimePromptMessage(routingContext.botProfile);
  }

  if (session.step === SESSION_STEPS.AWAITING_TIME) {
    const timeResult = normalizeTimeInput(cleanedMessage);

    if (!timeResult.isValid) {
      return getTimeValidationMessage();
    }

    session.data.time = timeResult.value;
    setSessionStep(sessionKey, SESSION_STEPS.AWAITING_CONFIRMATION);
    return getRequestConfirmationMessage(routingContext.botProfile, session);
  }

  if (session.step === SESSION_STEPS.AWAITING_CONFIRMATION) {
    if (['1', 'confirmar', 'sim', 'ok'].includes(normalizedMessage)) {
      return submitAppointmentRequest(sessionKey, from, session, routingContext);
    }

    if (['2', 'corrigir', 'editar', 'nao', 'não'].includes(normalizedMessage)) {
      return restartScheduling(sessionKey, buildSessionContext(from, routingContext));
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

async function montarRespostaBot({ sessionKey, from, routingContext, mensagemTexto }) {
  const botProfile = routingContext.botProfile;
  const textoNormalizado = normalizeMessage(mensagemTexto);
  const currentSession = sessions[sessionKey];

  if (isMenuCommand(textoNormalizado)) {
    resetSession(sessionKey, buildSessionContext(from, routingContext));
    return getWelcomeMenuMessage(botProfile);
  }

  if (isGreeting(textoNormalizado) && (!currentSession || currentSession.step === SESSION_STEPS.MENU)) {
    resetSession(sessionKey, buildSessionContext(from, routingContext));
    return getWelcomeMenuMessage(botProfile);
  }

  if (currentSession && isSchedulingStep(currentSession.step)) {
    return handleSchedulingFlow(sessionKey, from, routingContext, mensagemTexto);
  }

  const selectedMenuKey = resolveMenuOptionKey(textoNormalizado, botProfile);

  if (selectedMenuKey === 'schedule') {
    return startScheduling(sessionKey, buildSessionContext(from, routingContext));
  }

  if (selectedMenuKey === 'hours') {
    return getHoursMessage(botProfile);
  }

  if (selectedMenuKey === 'address') {
    return getAddressMessage(botProfile);
  }

  if (selectedMenuKey === 'human') {
    resetSession(sessionKey, buildSessionContext(from, routingContext));
    return getTalkToTeamMessage(botProfile);
  }

  return getConversationFallbackMessage(botProfile);
}

async function resolveBotProfileContext(from, to, routingContext) {
  const storedBotProfile = await getBotProfileByProject(routingContext.project.id);

  if (!storedBotProfile) {
    const fallbackBotProfile = buildEffectiveBotProfile({
      project: routingContext.project,
      botProfile: null,
    });

    console.log('[bot-profile] Nenhum BotProfile encontrado. Usando fallback seguro:', {
      from,
      to,
      projectId: routingContext.project.id,
      fallbackFields: fallbackBotProfile.fallbackFields,
    });

    return fallbackBotProfile;
  }

  if (isBotProfileInactive(storedBotProfile)) {
    const error = new Error(
      `BotProfile "${storedBotProfile.id}" encontrado para o projeto "${routingContext.project.id}", mas marcado como inativo.`,
    );
    error.code = 'bot_profile_inactive';
    error.projectId = routingContext.project.id;
    error.botProfileId = storedBotProfile.id;
    throw error;
  }

  const effectiveBotProfile = buildEffectiveBotProfile({
    project: routingContext.project,
    botProfile: storedBotProfile,
  });

  console.log('[bot-profile] BotProfile ativo resolvido:', {
    from,
    to,
    projectId: routingContext.project.id,
    botProfileId: effectiveBotProfile.id,
    fallbackUsed: effectiveBotProfile.fallbackUsed,
    fallbackFields: effectiveBotProfile.fallbackFields,
    menuEnabled: effectiveBotProfile.menuOptions
      .filter((option) => option.enabled)
      .map((option) => option.key),
  });

  return effectiveBotProfile;
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

  const from = String(req.body.From || 'unknown').trim();
  const to = String(req.body.To || '').trim();
  const mensagemRecebida = req.body.Body || '';
  const sessionKey = buildSessionKey(from, to);

  console.log('[webhook] Número do remetente:', from);
  console.log('[webhook] Número de destino:', to);
  console.log('[webhook] Mensagem recebida:', mensagemRecebida);

  // O `/dev` existe apenas para teste/demo no WhatsApp Sandbox, onde um unico
  // numero precisa alternar tenants sem mudar o roteamento oficial do bot.
  const devCommandResult = await handleDevCommand({
    from,
    messageText: mensagemRecebida,
  });

  if (devCommandResult.matched) {
    console.log('[dev] Comando recebido:', {
      from,
      to,
      action: devCommandResult.action,
      available: devCommandResult.available !== false,
      input: devCommandResult.parsedCommand?.rawInput || null,
    });

    const session = ensureSession(sessionKey, {
      from,
      to: String(to || '').trim().toLowerCase() || null,
    });

    if (devCommandResult.action === 'set_project' && devCommandResult.project) {
      const projectOverride = setSessionProjectOverride(session, devCommandResult.project);

      resetSession(
        sessionKey,
        {
          from,
          to: String(to || '').trim().toLowerCase() || null,
          projectId: devCommandResult.project.id,
          devMode: true,
          projectOverrideUsed: true,
          routingSource: 'session_override',
        },
        { preserveProjectOverride: true },
      );

      console.log('[dev] Override de projeto ativado:', {
        from,
        to,
        sessionKey,
        projectId: projectOverride?.projectId || null,
        projectSlug: projectOverride?.projectSlug || null,
        projectName: projectOverride?.projectName || null,
        matchedBy: devCommandResult.resolution?.matchedBy || null,
      });
    } else if (devCommandResult.action === 'reset') {
      const previousOverride = clearSessionProjectOverride(session);

      resetSession(
        sessionKey,
        {
          from,
          to: String(to || '').trim().toLowerCase() || null,
          devMode: false,
          projectOverrideUsed: false,
          routingSource: 'incoming_number',
        },
        { preserveProjectOverride: false },
      );

      console.log('[dev] Override removido da sessao:', {
        from,
        to,
        sessionKey,
        previousProjectId: previousOverride?.projectId || null,
        previousProjectSlug: previousOverride?.projectSlug || null,
      });
    } else if (devCommandResult.action === 'invalid_project') {
      console.warn('[dev] Tentativa de override invalida:', {
        from,
        to,
        sessionKey,
        input: devCommandResult.parsedCommand?.rawInput || null,
        message: devCommandResult.error?.message || null,
        code: devCommandResult.error?.code || null,
      });
    }

    logCurrentSession(sessionKey);

    const devTwiml = new twilio.twiml.MessagingResponse();
    devTwiml.message(devCommandResult.response);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(devTwiml.toString());
  }

  let routingContext;

  try {
    console.log('[routing] Iniciando resolução do projeto da conversa:', {
      from,
      to,
      sessionKey,
      hasProjectOverride: Boolean(getSessionProjectOverride(sessions[sessionKey])),
    });

    routingContext = await resolveProjectForConversation({
      to,
      session: sessions[sessionKey],
    });
  } catch (error) {
    console.error('[routing] Falha ao resolver canal do WhatsApp:', {
      from,
      to,
      code: error.code || null,
      message: error.message,
      connectionId: error.connectionId || null,
      projectId: error.projectId || null,
    });

    await logProjectRoutingFailure({
      phone: from,
      to,
      error,
    });

    const unavailableTwiml = new twilio.twiml.MessagingResponse();
    unavailableTwiml.message(getChannelUnavailableMessage());

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(unavailableTwiml.toString());
  }

  try {
    const botProfile = await resolveBotProfileContext(from, to, routingContext);
    routingContext.botProfile = botProfile;
  } catch (error) {
    console.error('[bot-profile] Falha ao resolver BotProfile do projeto:', {
      from,
      to,
      projectId: routingContext.project?.id || null,
      code: error.code || null,
      message: error.message,
      botProfileId: error.botProfileId || null,
    });

    await logBotProfileResolutionFailure({
      phone: from,
      to,
      projectId: routingContext.project?.id || null,
      botProfileId: error.botProfileId || null,
      error,
      metadata: {
        connectionId: routingContext.connection?.id || null,
      },
    });

    const unavailableTwiml = new twilio.twiml.MessagingResponse();
    unavailableTwiml.message(getChannelUnavailableMessage(null));

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(unavailableTwiml.toString());
  }

  console.log('[routing] Contexto resolvido para a conversa:', {
    sessionKey,
    from,
    to: routingContext.to,
    projectId: routingContext.project.id,
    connectionId: routingContext.connection?.id || null,
    routingSource: routingContext.routingSource || null,
    devMode: routingContext.devMode || false,
    projectOverrideUsed: routingContext.projectOverrideUsed || false,
    botProfileId: routingContext.botProfile?.id || null,
    botProfileFallbackUsed: routingContext.botProfile?.fallbackUsed || false,
  });
  logCurrentSession(sessionKey);

  // TwiML e o XML que a Twilio entende como instrucao de resposta.
  // Aqui usamos a biblioteca oficial para montar a resposta do WhatsApp.
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(
    await montarRespostaBot({
      sessionKey,
      from,
      routingContext,
      mensagemTexto: mensagemRecebida,
    }),
  );

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml.toString());
};
