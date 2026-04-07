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
  getNamePromptMessage,
  getNameValidationMessage,
  getRegistrationFailureMessage,
  getRequestConfirmationMessage,
  getRequestRegisteredMessage,
  getRestartSchedulingMessage,
  getServiceSelectionErrorMessage,
  getServiceUnavailableMessage,
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
const {
  loadRuntimeProjectServices,
  normalizeSelectedService,
  resolveServiceSelection,
} = require('../lib/bot/services');
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
  buildSessionDocumentId,
  upsertBotSession,
} = require('../lib/core/sessions');
const {
  getBotProfileByProject,
  isBotProfileInactive,
} = require('../lib/core/botProfiles');
const { resolveProjectForConversation } = require('../lib/routing/resolveProject');
const { ACTIVE_TENANT_SLUG } = require('../lib/tenant');

const SESSION_STEPS = {
  MENU: 'menu',
  AWAITING_SERVICE: 'awaiting_service',
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
// Nesta fase o bot opera apenas com o tenant piloto. A sessao continua isolada
// por origem + canal recebido, mas todo o fluxo persiste tenantSlug fixo.
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
    tenantSlug: ACTIVE_TENANT_SLUG,
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
  const tenantSlug = ACTIVE_TENANT_SLUG;

  return {
    step: SESSION_STEPS.MENU,
    tenantSlug,
    data: {
      selectedServiceKey: '',
      selectedServiceLabel: '',
      name: '',
      date: '',
      time: '',
    },
    projectOverride: projectOverride || null,
    context: {
      from: context.from || '',
      to: context.to || null,
      projectId: context.projectId || null,
      tenantSlug,
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
    SESSION_STEPS.AWAITING_SERVICE,
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
    tenantSlug: sessions[sessionKey].tenantSlug || null,
    step: sessions[sessionKey].step,
    data: sessions[sessionKey].data,
    projectOverride: sessions[sessionKey].projectOverride || null,
    context: sessions[sessionKey].context,
  });
}

async function persistSessionState(sessionKey, options = {}) {
  const session = sessions[sessionKey];

  if (!session) {
    return null;
  }

  try {
    return await upsertBotSession({
      sessionKey,
      session,
      status: options.status || 'active',
      lastInboundText: options.lastInboundText ?? null,
    });
  } catch (error) {
    console.error('[bot-runtime] sessionPersistFailed', {
      sessionKey,
      tenantSlug: session.tenantSlug || null,
      currentStep: session.step || null,
      message: error.message,
      code: error.code || null,
    });
    return null;
  }
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
    const contextTenantSlug = ACTIVE_TENANT_SLUG;

    sessions[sessionKey].tenantSlug = contextTenantSlug;
    sessions[sessionKey].context = {
      ...sessions[sessionKey].context,
      ...context,
      tenantSlug: contextTenantSlug,
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

async function resolveProjectServices(routingContext, options = {}) {
  const tenantSlug = ACTIVE_TENANT_SLUG;
  const serviceCatalog = await loadRuntimeProjectServices(routingContext?.project || null, {
    tenantSlug,
  });

  if (options.log !== false) {
    const serviceKeys = serviceCatalog.services.map((service) => service.key);
    const servicesSource =
      serviceCatalog.servicesSource || serviceCatalog.firebaseProjectId || serviceCatalog.source || null;

    console.log(`[bot] servicesSource=${servicesSource || 'unknown'}`);
    console.log(`[bot] tenantSelected=${tenantSlug}`);
    console.log(`[bot] servicesLoaded=${serviceCatalog.services.length}`);
    console.log(`[bot-runtime] servicesKeys=[${serviceKeys.join(', ')}]`);
    console.log('[services] Servicos carregados para o fluxo de agendamento:', {
      projectId: routingContext?.project?.id || null,
      projectSlug: routingContext?.project?.slug || null,
      activeTenantSlug: tenantSlug,
      tenantSlug,
      firebaseProjectId: serviceCatalog.firebaseProjectId || null,
      servicesSource,
      source: serviceCatalog.source,
      resolvedFrom: serviceCatalog.resolvedFrom || null,
      usedFallback: serviceCatalog.usedFallback,
      totalServices: serviceCatalog.services.length,
      serviceKeys,
    });
  }

  return serviceCatalog;
}

function getSelectedServiceFromSession(session) {
  return normalizeSelectedService({
    key: session?.data?.selectedServiceKey,
    label: session?.data?.selectedServiceLabel,
  });
}

async function startScheduling(sessionKey, context, routingContext) {
  resetSession(sessionKey, context);
  setSessionStep(sessionKey, SESSION_STEPS.AWAITING_SERVICE);
  const session = ensureSession(sessionKey, context);

  const serviceCatalog = await resolveProjectServices(routingContext, { session });
  await persistSessionState(sessionKey);

  if (serviceCatalog.services.length === 0) {
    return getServiceUnavailableMessage(context.botProfile || null);
  }

  return getSchedulingWelcomeMessage(context.botProfile || null, serviceCatalog.services);
}

async function restartScheduling(sessionKey, context, routingContext) {
  resetSession(sessionKey, context);
  setSessionStep(sessionKey, SESSION_STEPS.AWAITING_SERVICE);
  const session = ensureSession(sessionKey, context);

  const serviceCatalog = await resolveProjectServices(routingContext, { session });
  await persistSessionState(sessionKey);

  if (serviceCatalog.services.length === 0) {
    return getServiceUnavailableMessage(context.botProfile || null);
  }

  return `${getRestartSchedulingMessage(context.botProfile || null)}

${serviceCatalog.services.map((service, index) => `${index + 1} - ${service.label}`).join('\n')}`;
}

async function submitAppointmentRequest(sessionKey, from, session, routingContext) {
  const selectedService = getSelectedServiceFromSession(session);
  const sessionId = buildSessionDocumentId(sessionKey);
  const tenantSlug = ACTIVE_TENANT_SLUG;

  try {
    console.log('[core] Iniciando persistencia oficial da solicitacao:', {
      phone: from,
      to: routingContext.to,
      projectId: routingContext.project.id,
      tenantSlug,
      connectionId: routingContext.connection?.id || null,
      routingSource: routingContext.routingSource || null,
      devMode: routingContext.devMode || false,
      projectOverrideUsed: routingContext.projectOverrideUsed || false,
      botProfileId: routingContext.botProfile?.id || null,
      botProfileFallbackUsed: routingContext.botProfile?.fallbackUsed || false,
      service: selectedService,
      name: session.data.name,
      requestedDate: session.data.date,
      requestedTime: session.data.time,
    });

    const registrationResult = await registerAppointmentServiceRequest({
      phone: from,
      name: session.data.name,
      requestedDate: session.data.date,
      requestedTime: session.data.time,
      sessionId,
      tenantSlug,
      service: selectedService,
      routingContext,
    });

    console.log(`[bot] serviceRequestCreated=${registrationResult.serviceRequest.id}`);
    console.log('[core] Persistencia oficial concluida:', {
      projectId: registrationResult.project.id,
      tenantSlug: registrationResult.serviceRequest.data.tenantSlug || tenantSlug,
      connectionId: routingContext.connection?.id || null,
      contactId: registrationResult.contact.id,
      sessionId,
      serviceRequestId: registrationResult.serviceRequest.id,
      phone: from,
      to: routingContext.to,
      botProfileId: routingContext.botProfile?.id || null,
      service: selectedService,
    });

    const successMessage = getRequestRegisteredMessage(routingContext.botProfile, session);
    await persistSessionState(sessionKey, { status: 'service_request_created' });
    closeSession(sessionKey, buildSessionContext(from, routingContext));
    await persistSessionState(sessionKey);

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
        tenantSlug,
        botProfileId: routingContext.botProfile?.id || null,
        botProfileFallbackUsed: routingContext.botProfile?.fallbackUsed || false,
        service: selectedService,
      },
    });
    return getRegistrationFailureMessage(routingContext.botProfile);
  }
}

async function handleSchedulingFlow(sessionKey, from, routingContext, messageText) {
  const session = ensureSession(sessionKey, buildSessionContext(from, routingContext));
  const cleanedMessage = String(messageText || '').trim();
  const normalizedMessage = normalizeMessage(messageText);
  const serviceCatalog = await resolveProjectServices(routingContext, {
    session,
    log: session.step === SESSION_STEPS.AWAITING_SERVICE,
  });

  if (serviceCatalog.services.length === 0) {
    console.warn('[services] Fluxo de agendamento sem servicos disponiveis.', {
      sessionKey,
      projectId: routingContext?.project?.id || null,
      tenantSlug: ACTIVE_TENANT_SLUG,
    });
    return getServiceUnavailableMessage(routingContext.botProfile);
  }

  if (session.step !== SESSION_STEPS.AWAITING_SERVICE && !getSelectedServiceFromSession(session)) {
    console.warn('[services] Sessao sem servico selecionado. Reiniciando etapa de escolha.', {
      sessionKey,
      step: session.step,
      projectId: routingContext?.project?.id || null,
      tenantSlug: ACTIVE_TENANT_SLUG,
    });
    return await startScheduling(sessionKey, buildSessionContext(from, routingContext), routingContext);
  }

  if (session.step === SESSION_STEPS.AWAITING_SERVICE) {
    const serviceSelection = resolveServiceSelection(cleanedMessage, serviceCatalog.services, {
      numberOnly: true,
    });

    if (!serviceSelection.isValid) {
      console.warn('[services] Servico invalido informado pelo usuario.', {
        sessionKey,
        projectId: routingContext?.project?.id || null,
        tenantSlug: ACTIVE_TENANT_SLUG,
        input: cleanedMessage,
        code: serviceSelection.code,
      });
      return getServiceSelectionErrorMessage(serviceCatalog.services);
    }

    session.data.selectedServiceKey = serviceSelection.service.key;
    session.data.selectedServiceLabel = serviceSelection.service.label;

    console.log(`[bot] serviceSelected=${session.data.selectedServiceKey}`);
    console.log('[services] Servico selecionado na sessao:', {
      sessionKey,
      projectId: routingContext?.project?.id || null,
      tenantSlug: ACTIVE_TENANT_SLUG,
      serviceKey: session.data.selectedServiceKey,
      serviceLabel: session.data.selectedServiceLabel,
    });

    setSessionStep(sessionKey, SESSION_STEPS.AWAITING_NAME);
    await persistSessionState(sessionKey, { lastInboundText: cleanedMessage });
    return getNamePromptMessage(routingContext.botProfile, session.data.selectedServiceLabel);
  }

  if (session.step === SESSION_STEPS.AWAITING_NAME) {
    const nameResult = normalizeNameInput(cleanedMessage);

    if (!nameResult.isValid) {
      return getNameValidationMessage();
    }

    session.data.name = nameResult.value;
    setSessionStep(sessionKey, SESSION_STEPS.AWAITING_DATE);
    await persistSessionState(sessionKey, { lastInboundText: cleanedMessage });
    return getDatePromptMessage(routingContext.botProfile, session.data.name);
  }

  if (session.step === SESSION_STEPS.AWAITING_DATE) {
    const dateResult = normalizeDateInput(cleanedMessage);

    if (!dateResult.isValid) {
      return getDateValidationMessage();
    }

    session.data.date = dateResult.value;
    setSessionStep(sessionKey, SESSION_STEPS.AWAITING_TIME);
    await persistSessionState(sessionKey, { lastInboundText: cleanedMessage });
    return getTimePromptMessage(routingContext.botProfile);
  }

  if (session.step === SESSION_STEPS.AWAITING_TIME) {
    const timeResult = normalizeTimeInput(cleanedMessage);

    if (!timeResult.isValid) {
      return getTimeValidationMessage();
    }

    session.data.time = timeResult.value;
    setSessionStep(sessionKey, SESSION_STEPS.AWAITING_CONFIRMATION);
    await persistSessionState(sessionKey, { lastInboundText: cleanedMessage });
    return getRequestConfirmationMessage(routingContext.botProfile, session);
  }

  if (session.step === SESSION_STEPS.AWAITING_CONFIRMATION) {
    if (['1', 'confirmar', 'sim', 'ok'].includes(normalizedMessage)) {
      return submitAppointmentRequest(sessionKey, from, session, routingContext);
    }

    if (['2', 'corrigir', 'editar', 'nao', 'não'].includes(normalizedMessage)) {
      return await restartScheduling(
        sessionKey,
        buildSessionContext(from, routingContext),
        routingContext,
      );
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
    await persistSessionState(sessionKey, { lastInboundText: mensagemTexto });
    return getWelcomeMenuMessage(botProfile);
  }

  if (isGreeting(textoNormalizado) && (!currentSession || currentSession.step === SESSION_STEPS.MENU)) {
    resetSession(sessionKey, buildSessionContext(from, routingContext));
    await persistSessionState(sessionKey, { lastInboundText: mensagemTexto });
    return getWelcomeMenuMessage(botProfile);
  }

  if (currentSession && isSchedulingStep(currentSession.step)) {
    return await handleSchedulingFlow(sessionKey, from, routingContext, mensagemTexto);
  }

  const selectedMenuKey = resolveMenuOptionKey(textoNormalizado, botProfile);

  if (selectedMenuKey === 'schedule') {
    return await startScheduling(sessionKey, buildSessionContext(from, routingContext), routingContext);
  }

  if (selectedMenuKey === 'hours') {
    return getHoursMessage(botProfile);
  }

  if (selectedMenuKey === 'address') {
    return getAddressMessage(botProfile);
  }

  if (selectedMenuKey === 'human') {
    resetSession(sessionKey, buildSessionContext(from, routingContext));
    await persistSessionState(sessionKey, { lastInboundText: mensagemTexto });
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

async function handler(req, res) {
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
  console.log(`[bot] activeTenant=${ACTIVE_TENANT_SLUG}`);

  // O `/dev` existe apenas para teste/demo no WhatsApp Sandbox. Nesta fase,
  // ele aceita somente o tenant piloto clinica-devtec.
  const devCommandResult = await handleDevCommand({
    from,
    messageText: mensagemRecebida,
  });

  if (devCommandResult.matched) {
    const devCommandSuffix = devCommandResult.parsedCommand?.normalizedInput
      ? ` ${devCommandResult.parsedCommand.normalizedInput}`
      : '';
    console.log(`[bot] command=/dev${devCommandSuffix}`);
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
      tenantSlug: ACTIVE_TENANT_SLUG,
    });

    if (devCommandResult.action === 'set_project' && devCommandResult.project) {
      const projectOverride = setSessionProjectOverride(session, devCommandResult.project);
      const tenantSlug = ACTIVE_TENANT_SLUG;

      resetSession(
        sessionKey,
        {
          from,
          to: String(to || '').trim().toLowerCase() || null,
          projectId: devCommandResult.project.id,
          tenantSlug,
          devMode: true,
          projectOverrideUsed: true,
          routingSource: 'session_override',
        },
        { preserveProjectOverride: true },
      );

      console.log(`[bot] tenantSelected=${tenantSlug || 'null'}`);
      console.log('[dev] Override de projeto ativado:', {
        from,
        to,
        sessionKey,
        projectId: projectOverride?.projectId || null,
        projectSlug: projectOverride?.projectSlug || null,
        tenantSlug,
        projectName: projectOverride?.projectName || null,
        matchedBy: devCommandResult.resolution?.matchedBy || null,
      });
      await persistSessionState(sessionKey, { lastInboundText: mensagemRecebida });
    } else if (devCommandResult.action === 'reset') {
      const previousOverride = clearSessionProjectOverride(session);

      resetSession(
        sessionKey,
        {
          from,
          to: String(to || '').trim().toLowerCase() || null,
          tenantSlug: ACTIVE_TENANT_SLUG,
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
        activeTenantSlug: ACTIVE_TENANT_SLUG,
      });
      await persistSessionState(sessionKey, { lastInboundText: mensagemRecebida });
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
      activeTenantSlug: ACTIVE_TENANT_SLUG,
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
      activeTenantSlug: ACTIVE_TENANT_SLUG,
    });

    await logProjectRoutingFailure({
      phone: from,
      to,
      error,
      metadata: {
        activeTenantSlug: ACTIVE_TENANT_SLUG,
      },
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
      activeTenantSlug: ACTIVE_TENANT_SLUG,
    });

    await logBotProfileResolutionFailure({
      phone: from,
      to,
      projectId: routingContext.project?.id || null,
      botProfileId: error.botProfileId || null,
      error,
      metadata: {
        connectionId: routingContext.connection?.id || null,
        activeTenantSlug: ACTIVE_TENANT_SLUG,
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
    tenantSlug: ACTIVE_TENANT_SLUG,
    activeTenantSlug: ACTIVE_TENANT_SLUG,
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
}

function clearSessions() {
  Object.keys(sessions).forEach((sessionKey) => {
    delete sessions[sessionKey];
  });
}

module.exports = handler;
module.exports.__internals = {
  SESSION_STEPS,
  buildSessionContext,
  buildSessionKey,
  clearSessions,
  createInitialSession,
  ensureSession,
  getSelectedServiceFromSession,
  handleSchedulingFlow,
  isSchedulingStep,
  montarRespostaBot,
  normalizeMessage,
  resetSession,
  resolveProjectServices,
  sessions,
  startScheduling,
};
