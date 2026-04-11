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
  findBotSessionsByPhone,
  getBotSession,
  upsertBotSession,
} = require('../lib/core/sessions');
const {
  getBotProfileByProject,
  isBotProfileInactive,
} = require('../lib/core/botProfiles');
const { getProjectById } = require('../lib/core/projects');
const { logInboundEvent } = require('../lib/core/inboundEvents');
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

function normalizeChannelAddress(value) {
  return normalizeSessionIdentifier(value) || null;
}

function hasContextValue(value) {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  return value !== null && typeof value !== 'undefined';
}

function pickContextValue(...values) {
  for (const value of values) {
    if (hasContextValue(value)) {
      return typeof value === 'string' ? String(value).trim() : value;
    }
  }

  return null;
}

function extractStoredSessionTo(sessionData = {}) {
  return normalizeChannelAddress(
    sessionData?.context?.to ||
      sessionData?.to ||
      sessionData?.context?.connectionIdentifier ||
      null,
  );
}

function extractStoredConnectionIdentifier(sessionData = {}) {
  return normalizeChannelAddress(
    sessionData?.context?.connectionIdentifier ||
      sessionData?.context?.to ||
      sessionData?.to ||
      null,
  );
}

function mergeSessionContext(baseContext = {}, nextContext = {}) {
  const mergedTo =
    normalizeChannelAddress(nextContext.to || nextContext.connectionIdentifier) ||
    normalizeChannelAddress(baseContext.to || baseContext.connectionIdentifier);
  const mergedConnectionIdentifier =
    normalizeChannelAddress(nextContext.connectionIdentifier || nextContext.to) ||
    normalizeChannelAddress(baseContext.connectionIdentifier || baseContext.to);

  return {
    from: pickContextValue(nextContext.from, baseContext.from, ''),
    to: mergedTo,
    projectId: pickContextValue(nextContext.projectId, baseContext.projectId),
    tenantSlug: ACTIVE_TENANT_SLUG,
    connectionId: pickContextValue(nextContext.connectionId, baseContext.connectionId),
    connectionIdentifier: mergedConnectionIdentifier,
    botProfile: pickContextValue(nextContext.botProfile, baseContext.botProfile),
    botProfileId: pickContextValue(nextContext.botProfileId, baseContext.botProfileId),
    botProfileFallbackUsed:
      typeof nextContext.botProfileFallbackUsed === 'boolean'
        ? nextContext.botProfileFallbackUsed
        : typeof baseContext.botProfileFallbackUsed === 'boolean'
          ? baseContext.botProfileFallbackUsed
          : false,
    botProfileSource: pickContextValue(nextContext.botProfileSource, baseContext.botProfileSource),
    routingSource: pickContextValue(nextContext.routingSource, baseContext.routingSource),
    devMode:
      typeof nextContext.devMode === 'boolean'
        ? nextContext.devMode
        : typeof baseContext.devMode === 'boolean'
          ? baseContext.devMode
          : false,
    projectOverrideUsed:
      typeof nextContext.projectOverrideUsed === 'boolean'
        ? nextContext.projectOverrideUsed
        : typeof baseContext.projectOverrideUsed === 'boolean'
          ? baseContext.projectOverrideUsed
          : false,
  };
}

function buildTwilioPayloadLog(body = {}) {
  return {
    from: body.From || null,
    to: body.To || null,
    messageSid: body.MessageSid || body.SmsMessageSid || null,
    accountSid: body.AccountSid || null,
    waId: body.WaId || null,
    profileName: body.ProfileName || null,
    bodyLength: String(body.Body || '').length,
  };
}

function findSessionCandidateInMemoryByPhone(from) {
  const normalizedFrom = normalizeSessionIdentifier(from);
  const matches = Object.entries(sessions).filter(([, session]) => {
    return normalizeSessionIdentifier(session?.context?.from || '') === normalizedFrom;
  });

  if (matches.length !== 1) {
    return null;
  }

  const [sessionKey, session] = matches[0];
  const sessionTo =
    normalizeChannelAddress(session?.context?.to || session?.context?.connectionIdentifier) ||
    normalizeChannelAddress(sessionKey.split('::')[1] || '');

  if (!sessionTo) {
    return null;
  }

  return {
    sessionKey,
    to: sessionTo,
    source: 'memory_session',
  };
}

async function findSessionCandidateInFirestoreByPhone(from) {
  const sessionRecords = await findBotSessionsByPhone(from, { limit: 10 });
  const candidates = sessionRecords
    .map((record) => ({
      sessionId: record.id,
      sessionKey: String(record.data?.sessionKey || '').trim() || null,
      to: extractStoredSessionTo(record.data),
      connectionIdentifier: extractStoredConnectionIdentifier(record.data),
      projectId: record.data?.context?.projectId || record.data?.projectId || null,
      connectionId: record.data?.context?.connectionId || null,
      status: record.data?.status || null,
    }))
    .filter((candidate) => candidate.to);
  const distinctToValues = [...new Set(candidates.map((candidate) => candidate.to))];

  if (distinctToValues.length !== 1) {
    return {
      sessionKey: null,
      to: null,
      source: null,
      reason: candidates.length === 0 ? 'phone_lookup_no_to' : 'phone_lookup_ambiguous',
      candidates,
    };
  }

  const selectedTo = distinctToValues[0];
  const preferredCandidate =
    candidates.find(
      (candidate) =>
        candidate.projectId && (candidate.connectionId || candidate.connectionIdentifier),
    ) || candidates[0];

  return {
    sessionKey: preferredCandidate.sessionKey || buildSessionKey(from, selectedTo),
    to: selectedTo,
    source: 'persisted_session_phone_lookup',
    reason: null,
    candidates,
  };
}

async function resolveIncomingAddressing({ from, requestTo }) {
  const normalizedRequestTo = normalizeChannelAddress(requestTo);

  if (normalizedRequestTo) {
    return {
      requestTo: normalizedRequestTo,
      currentTo: normalizedRequestTo,
      persistedTo: null,
      source: 'request',
      sessionKey: buildSessionKey(from, normalizedRequestTo),
      candidateReason: null,
      candidateCount: 0,
    };
  }

  const inMemoryCandidate = findSessionCandidateInMemoryByPhone(from);

  if (inMemoryCandidate) {
    return {
      requestTo: null,
      currentTo: inMemoryCandidate.to,
      persistedTo: inMemoryCandidate.to,
      source: inMemoryCandidate.source,
      sessionKey: inMemoryCandidate.sessionKey,
      candidateReason: null,
      candidateCount: 1,
    };
  }

  const persistedCandidate = await findSessionCandidateInFirestoreByPhone(from);

  return {
    requestTo: null,
    currentTo: persistedCandidate.to || null,
    persistedTo: persistedCandidate.to || null,
    source: persistedCandidate.source || 'unresolved',
    sessionKey:
      persistedCandidate.sessionKey ||
      buildSessionKey(from, persistedCandidate.to || null),
    candidateReason: persistedCandidate.reason || null,
    candidateCount: persistedCandidate.candidates?.length || 0,
  };
}

function buildSessionContext(from, routingContext) {
  const contextTo = normalizeChannelAddress(
    routingContext?.to || routingContext?.connection?.identifier || null,
  );

  return {
    from: String(from || '').trim(),
    to: contextTo,
    projectId: routingContext?.project?.id || null,
    tenantSlug: ACTIVE_TENANT_SLUG,
    connectionId: routingContext?.connection?.id || null,
    connectionIdentifier:
      normalizeChannelAddress(routingContext?.connection?.identifier || contextTo) || null,
    botProfile: routingContext?.botProfile || null,
    botProfileId: routingContext?.botProfile?.id || null,
    botProfileFallbackUsed: routingContext?.botProfile?.fallbackUsed || false,
    botProfileSource: routingContext?.botProfile?.source || null,
    routingSource: routingContext?.routingSource || null,
    devMode: routingContext?.devMode || false,
    projectOverrideUsed: routingContext?.projectOverrideUsed || false,
  };
}

function logFlow(stage, metadata = {}) {
  console.log(`[bot][flow] ${stage}`, metadata);
}

function logEarlyReturn(reason, metadata = {}) {
  console.log(`[bot][flow] earlyReturnReason=${reason}`, metadata);
}

function hasResponseMessage(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getSessionProjectId(session) {
  return (
    session?.context?.projectId ||
    session?.projectOverride?.projectId ||
    null
  );
}

function logContextResolution(label, value, metadata = {}) {
  console.log(`[bot][context] ${label}=${value ?? 'null'}`, metadata);
}

function logMissingContextLink(reason, metadata = {}) {
  console.warn(`[bot][context] missingLink reason=${reason}`, metadata);
}

function getSessionRoutingReuseDecision(session, to) {
  const projectId = getSessionProjectId(session);
  const connectionId = session?.context?.connectionId || null;
  const connectionIdentifier = session?.context?.connectionIdentifier || null;
  const projectOverrideActive = Boolean(getSessionProjectOverride(session));
  const sessionTo = normalizeChannelAddress(
    session?.context?.to || session?.context?.connectionIdentifier || '',
  );
  const currentTo = normalizeChannelAddress(to);

  if (!projectId) {
    return {
      canReuse: false,
      reason: 'session_missing_projectId',
      projectId: null,
      connectionId,
      connectionIdentifier,
    };
  }

  if (projectOverrideActive) {
    return {
      canReuse: true,
      reason: 'session_override_active',
      projectId,
      connectionId,
      connectionIdentifier,
    };
  }

  if (!connectionId) {
    return {
      canReuse: false,
      reason: 'session_missing_connectionId',
      projectId,
      connectionId,
      connectionIdentifier,
    };
  }

  if (sessionTo && currentTo && sessionTo !== currentTo) {
    return {
      canReuse: false,
      reason: 'session_destination_mismatch',
      projectId,
      connectionId,
      connectionIdentifier,
      sessionTo,
      currentTo,
    };
  }

  return {
    canReuse: true,
    reason: 'session_context_complete',
    projectId,
    connectionId,
    connectionIdentifier,
    sessionTo,
    currentTo,
  };
}

function getStepLogName(step) {
  if (step === SESSION_STEPS.AWAITING_NAME) {
    return 'AWAITING_CUSTOMER_NAME';
  }

  return String(step || '').trim().toUpperCase() || 'UNKNOWN';
}

function createInitialSession(context = {}, projectOverride = null) {
  const tenantSlug = ACTIVE_TENANT_SLUG;
  const normalizedContext = mergeSessionContext(
    {},
    {
      ...context,
      projectId: pickContextValue(context.projectId, projectOverride?.projectId),
    },
  );

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
      from: normalizedContext.from || '',
      to: normalizedContext.to || null,
      projectId: normalizedContext.projectId || null,
      tenantSlug,
      connectionId: normalizedContext.connectionId || null,
      connectionIdentifier: normalizedContext.connectionIdentifier || null,
      botProfile: normalizedContext.botProfile || null,
      botProfileId: normalizedContext.botProfileId || null,
      botProfileFallbackUsed: normalizedContext.botProfileFallbackUsed || false,
      botProfileSource: normalizedContext.botProfileSource || null,
      routingSource: normalizedContext.routingSource || null,
      devMode: normalizedContext.devMode || false,
      projectOverrideUsed: normalizedContext.projectOverrideUsed || false,
    },
  };
}

function hydratePersistedSession(sessionRecord, context = {}) {
  const persistedData = sessionRecord?.data || {};
  const persistedContext = persistedData.context || {};
  const normalizedContext = mergeSessionContext(persistedContext, {
    ...context,
    projectId: pickContextValue(
      context.projectId,
      persistedContext.projectId,
      persistedData.projectId,
      persistedData.projectOverride?.projectId,
    ),
    to: pickContextValue(
      context.to,
      persistedContext.to,
      persistedData.to,
      persistedContext.connectionIdentifier,
    ),
    connectionIdentifier: pickContextValue(
      context.connectionIdentifier,
      persistedContext.connectionIdentifier,
      persistedContext.to,
      persistedData.to,
    ),
  });
  const hydratedSession = createInitialSession(normalizedContext, persistedData.projectOverride || null);

  hydratedSession.step = persistedData.currentStep || hydratedSession.step;
  hydratedSession.data = {
    ...hydratedSession.data,
    ...(persistedData.data || {}),
  };
  hydratedSession.tenantSlug = ACTIVE_TENANT_SLUG;
  hydratedSession.context = {
    ...mergeSessionContext(hydratedSession.context, normalizedContext),
    tenantSlug: ACTIVE_TENANT_SLUG,
  };

  return hydratedSession;
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
    console.log('[bot][session] savingContext', {
      sessionKey,
      from: session.context?.from || null,
      to: session.context?.to || null,
      projectId: session.context?.projectId || null,
      connectionId: session.context?.connectionId || null,
      connectionIdentifier: session.context?.connectionIdentifier || null,
      botProfileId: session.context?.botProfileId || null,
      botProfileSource: session.context?.botProfileSource || null,
      tenantSlug: session.context?.tenantSlug || session.tenantSlug || null,
      currentStep: session.step || null,
    });
    logContextResolution('persistedTo', session.context?.to || null, {
      sessionKey,
      connectionIdentifier: session.context?.connectionIdentifier || null,
      projectId: session.context?.projectId || null,
      currentStep: session.step || null,
    });
    const persistedSession = await upsertBotSession({
      sessionKey,
      session,
      status: options.status || 'active',
      lastInboundText: options.lastInboundText ?? null,
    });

    logFlow('sessionSaved', {
      sessionKey,
      sessionId: persistedSession.id,
      projectId: persistedSession.data.projectId || null,
      currentStep: persistedSession.data.currentStep || null,
      to: persistedSession.data.context?.to || persistedSession.data.to || null,
      connectionIdentifier: persistedSession.data.context?.connectionIdentifier || null,
      status: options.status || 'active',
    });

    return persistedSession;
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

async function loadSessionState(sessionKey, context = {}) {
  if (sessions[sessionKey]) {
    ensureSession(sessionKey, context);
    console.log('[bot][session] rehydratedContext', {
      sessionKey,
      source: 'memory',
      from: sessions[sessionKey].context?.from || null,
      to: sessions[sessionKey].context?.to || null,
      projectId: sessions[sessionKey].context?.projectId || null,
      connectionId: sessions[sessionKey].context?.connectionId || null,
      connectionIdentifier: sessions[sessionKey].context?.connectionIdentifier || null,
      botProfileId: sessions[sessionKey].context?.botProfileId || null,
      botProfileSource: sessions[sessionKey].context?.botProfileSource || null,
      tenantSlug: sessions[sessionKey].context?.tenantSlug || null,
    });
    logContextResolution('rehydratedTo', sessions[sessionKey].context?.to || null, {
      sessionKey,
      source: 'memory',
      connectionIdentifier: sessions[sessionKey].context?.connectionIdentifier || null,
      projectId: sessions[sessionKey].context?.projectId || null,
    });
    logFlow('sessionLoaded', {
      sessionKey,
      source: 'memory',
      currentStep: sessions[sessionKey].step || null,
      projectId: sessions[sessionKey].context?.projectId || null,
    });
    return sessions[sessionKey];
  }

  try {
    const persistedSession = await getBotSession(sessionKey);

    if (!persistedSession) {
      sessions[sessionKey] = createInitialSession(context);
      console.log('[bot][session] rehydratedContext', {
        sessionKey,
        source: 'initialized',
        from: sessions[sessionKey].context?.from || null,
        to: sessions[sessionKey].context?.to || null,
        projectId: sessions[sessionKey].context?.projectId || null,
        connectionId: sessions[sessionKey].context?.connectionId || null,
        connectionIdentifier: sessions[sessionKey].context?.connectionIdentifier || null,
        botProfileId: sessions[sessionKey].context?.botProfileId || null,
        botProfileSource: sessions[sessionKey].context?.botProfileSource || null,
        tenantSlug: sessions[sessionKey].context?.tenantSlug || null,
      });
      logContextResolution('persistedTo', null, {
        sessionKey,
        source: 'initialized',
      });
      logContextResolution('rehydratedTo', sessions[sessionKey].context?.to || null, {
        sessionKey,
        source: 'initialized',
        connectionIdentifier: sessions[sessionKey].context?.connectionIdentifier || null,
      });
      logFlow('sessionLoaded', {
        sessionKey,
        source: 'initialized',
        currentStep: sessions[sessionKey].step || null,
        projectId: sessions[sessionKey].context?.projectId || null,
      });
      return sessions[sessionKey];
    }

    logContextResolution('persistedTo', extractStoredSessionTo(persistedSession.data), {
      sessionKey,
      source: 'firestore',
      connectionIdentifier: extractStoredConnectionIdentifier(persistedSession.data),
      projectId: persistedSession.data?.context?.projectId || persistedSession.data?.projectId || null,
    });
    sessions[sessionKey] = hydratePersistedSession(persistedSession, context);
    console.log('[bot][session] rehydratedContext', {
      sessionKey,
      source: 'firestore',
      from: sessions[sessionKey].context?.from || null,
      to: sessions[sessionKey].context?.to || null,
      projectId: sessions[sessionKey].context?.projectId || null,
      connectionId: sessions[sessionKey].context?.connectionId || null,
      connectionIdentifier: sessions[sessionKey].context?.connectionIdentifier || null,
      botProfileId: sessions[sessionKey].context?.botProfileId || null,
      botProfileSource: sessions[sessionKey].context?.botProfileSource || null,
      tenantSlug: sessions[sessionKey].context?.tenantSlug || null,
    });
    logContextResolution('rehydratedTo', sessions[sessionKey].context?.to || null, {
      sessionKey,
      source: 'firestore',
      connectionIdentifier: sessions[sessionKey].context?.connectionIdentifier || null,
      projectId: sessions[sessionKey].context?.projectId || null,
    });
    logFlow('sessionLoaded', {
      sessionKey,
      source: 'firestore',
      sessionId: persistedSession.id,
      currentStep: sessions[sessionKey].step || null,
      projectId: sessions[sessionKey].context?.projectId || null,
    });
    return sessions[sessionKey];
  } catch (error) {
    console.error('[bot-runtime] sessionLoadFailed', {
      sessionKey,
      message: error.message,
      code: error.code || null,
    });

    sessions[sessionKey] = createInitialSession(context);
    console.log('[bot][session] rehydratedContext', {
      sessionKey,
      source: 'initialized_after_error',
      from: sessions[sessionKey].context?.from || null,
      to: sessions[sessionKey].context?.to || null,
      projectId: sessions[sessionKey].context?.projectId || null,
      connectionId: sessions[sessionKey].context?.connectionId || null,
      connectionIdentifier: sessions[sessionKey].context?.connectionIdentifier || null,
      botProfileId: sessions[sessionKey].context?.botProfileId || null,
      botProfileSource: sessions[sessionKey].context?.botProfileSource || null,
      tenantSlug: sessions[sessionKey].context?.tenantSlug || null,
    });
    logFlow('sessionLoaded', {
      sessionKey,
      source: 'initialized_after_error',
      currentStep: sessions[sessionKey].step || null,
      projectId: sessions[sessionKey].context?.projectId || null,
    });
    return sessions[sessionKey];
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
      ...mergeSessionContext(sessions[sessionKey].context, context),
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

  sessions[sessionKey] = createInitialSession(
    {
      ...(previousSession?.context || {}),
      ...context,
    },
    projectOverride,
  );

  console.log('[session] Sessão finalizada:', {
    sessionKey,
    de: previousStep,
    para: sessions[sessionKey].step,
    projectOverride,
  });

  return sessions[sessionKey];
}

async function persistInboundReceivedEvent({
  from,
  messageText,
  sessionKey,
  routingContext,
  session,
}) {
  try {
    const inboundEvent = await logInboundEvent({
      phone: from,
      projectId: routingContext?.project?.id || null,
      eventType: 'message_received',
      status: 'received',
      metadata: {
        sessionKey,
        to: routingContext?.to || null,
        messageText: String(messageText || ''),
        currentStep: session?.step || null,
        connectionId: routingContext?.connection?.id || null,
        connectionIdentifier:
          routingContext?.connection?.identifier || routingContext?.to || null,
        tenantSlug: ACTIVE_TENANT_SLUG,
        botProfileId: routingContext?.botProfile?.id || null,
        botProfileFallbackUsed: routingContext?.botProfile?.fallbackUsed || false,
        botProfileSource: routingContext?.botProfile?.source || null,
      },
    });

    logFlow('inboundEventSaved', {
      eventType: 'message_received',
      inboundEventId: inboundEvent.id,
      sessionKey,
      projectId: routingContext?.project?.id || null,
    });

    return inboundEvent;
  } catch (error) {
    console.error('[bot-runtime] inboundEventPersistFailed', {
      sessionKey,
      phone: from,
      projectId: routingContext?.project?.id || null,
      message: error.message,
      code: error.code || null,
    });
    return null;
  }
}

async function resolveRoutingContextFromSession({
  from,
  to,
  sessionKey,
  session,
}) {
  const projectId = getSessionProjectId(session);

  if (!projectId) {
    return null;
  }

  const project = await getProjectById(projectId);
  const routingContext = {
    to:
      normalizeChannelAddress(
        session?.context?.to ||
          session?.context?.connectionIdentifier ||
          String(to || '').trim().toLowerCase() ||
          null,
      ) || null,
    connection:
      session?.context?.connectionId || session?.context?.connectionIdentifier
        ? {
            id: session.context.connectionId || null,
            identifier: session.context.connectionIdentifier || session.context.to || null,
          }
        : null,
    project,
    projectOverride: session?.projectOverride || null,
    tenantSlug: ACTIVE_TENANT_SLUG,
    devMode: session?.context?.devMode || false,
    projectOverrideUsed: session?.context?.projectOverrideUsed || false,
    routingSource: 'persisted_session',
    reusedSessionRouting: true,
  };

  console.log('[bot][routing] calledDuringStep=false', {
    sessionKey,
    from,
    to: routingContext.to,
    currentStep: session?.step || null,
    projectId,
    routingSource: routingContext.routingSource,
  });

  return routingContext;
}

function logResolvedRoutingContext(sessionKey, from, to, routingContext) {
  logContextResolution('tenantResolved', routingContext?.tenantSlug || ACTIVE_TENANT_SLUG, {
    sessionKey,
    from,
    to: routingContext?.to || String(to || '').trim().toLowerCase() || null,
    routingSource: routingContext?.routingSource || null,
  });
  logContextResolution('connectionResolved', routingContext?.connection?.id || null, {
    sessionKey,
    from,
    to: routingContext?.to || String(to || '').trim().toLowerCase() || null,
    connectionIdentifier: routingContext?.connection?.identifier || routingContext?.to || null,
    routingSource: routingContext?.routingSource || null,
  });
  logContextResolution(
    'connectionIdentifier',
    routingContext?.connection?.identifier || routingContext?.to || null,
    {
      sessionKey,
      from,
      to: routingContext?.to || String(to || '').trim().toLowerCase() || null,
      connectionId: routingContext?.connection?.id || null,
      routingSource: routingContext?.routingSource || null,
    },
  );
  logContextResolution('projectResolved', routingContext?.project?.id || null, {
    sessionKey,
    from,
    to: routingContext?.to || String(to || '').trim().toLowerCase() || null,
    tenantSlug: routingContext?.tenantSlug || ACTIVE_TENANT_SLUG,
    routingSource: routingContext?.routingSource || null,
  });
}

function logResolvedBotProfile(sessionKey, from, to, routingContext) {
  logContextResolution('botProfileResolved', routingContext?.botProfile?.id || null, {
    sessionKey,
    from,
    to: routingContext?.to || String(to || '').trim().toLowerCase() || null,
    projectId: routingContext?.project?.id || null,
    botProfileSource: routingContext?.botProfile?.source || null,
  });
  logContextResolution(
    'botProfileFallbackUsed',
    routingContext?.botProfile?.fallbackUsed === true,
    {
      sessionKey,
      from,
      to: routingContext?.to || String(to || '').trim().toLowerCase() || null,
      projectId: routingContext?.project?.id || null,
      botProfileId: routingContext?.botProfile?.id || null,
    },
  );
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
    logFlow('serviceRequestCreateStart', {
      sessionKey,
      sessionId,
      projectId: routingContext.project.id,
      phone: from,
      service: selectedService,
    });

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

    logFlow('contactSaved', {
      sessionKey,
      contactId: registrationResult.contact.id,
      projectId: registrationResult.project.id,
      phone: from,
      wasCreated: registrationResult.contact.wasCreated === true,
    });
    logFlow('serviceRequestCreated', {
      sessionKey,
      sessionId,
      serviceRequestId: registrationResult.serviceRequest.id,
      projectId: registrationResult.project.id,
      contactId: registrationResult.contact.id,
    });
    logFlow('inboundEventSaved', {
      eventType: 'service_request_created',
      inboundEventId: registrationResult.inboundEvent.id,
      sessionKey,
      projectId: registrationResult.project.id,
      serviceRequestId: registrationResult.serviceRequest.id,
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
    await persistSessionState(sessionKey, { status: 'completed' });

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
    logEarlyReturn('services_unavailable', {
      sessionKey,
      projectId: routingContext?.project?.id || null,
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
    logEarlyReturn('missing_selected_service', {
      sessionKey,
      currentStep: session.step,
      projectId: routingContext?.project?.id || null,
    });
    return await startScheduling(sessionKey, buildSessionContext(from, routingContext), routingContext);
  }

  if (session.step === SESSION_STEPS.AWAITING_SERVICE) {
    console.log('[bot][service-step] current=AWAITING_SERVICE', {
      sessionKey,
      projectId: getSessionProjectId(session),
      selectedServiceKey: session.data.selectedServiceKey || '',
      selectedServiceLabel: session.data.selectedServiceLabel || '',
    });
    console.log(`[bot][service-step] selected=${cleanedMessage}`);

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
      logEarlyReturn('invalid_service_selection', {
        sessionKey,
        projectId: routingContext?.project?.id || null,
        code: serviceSelection.code,
        input: cleanedMessage,
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
    console.log('[bot][service-step] next=AWAITING_NAME', {
      sessionKey,
      serviceKey: session.data.selectedServiceKey,
      serviceLabel: session.data.selectedServiceLabel,
    });

    const persistedSession = await persistSessionState(sessionKey, { lastInboundText: cleanedMessage });
    console.log('[bot][service-step] sessionPersisted', {
      sessionKey,
      persisted: Boolean(persistedSession),
      currentStep: sessions[sessionKey]?.step || null,
      selectedServiceKey: sessions[sessionKey]?.data?.selectedServiceKey || '',
      selectedServiceLabel: sessions[sessionKey]?.data?.selectedServiceLabel || '',
    });

    const namePromptMessage = getNamePromptMessage(
      routingContext.botProfile,
      session.data.selectedServiceLabel,
    );
    console.log('[bot][service-step] responseBuilt=true', {
      sessionKey,
      responseLength: namePromptMessage.length,
    });
    return namePromptMessage;
  }

  if (session.step === SESSION_STEPS.AWAITING_NAME) {
    console.log('[bot][step] current=AWAITING_CUSTOMER_NAME', {
      sessionKey,
      projectId: getSessionProjectId(session),
    });
    console.log(`[bot][input] customerName=${cleanedMessage}`);
    console.log('[bot][session] loaded tenantSlug=... step=...', {
      sessionKey,
      tenantSlug: session.tenantSlug || null,
      step: session.step || null,
      projectId: getSessionProjectId(session),
      selectedServiceKey: session.data.selectedServiceKey || '',
      selectedServiceLabel: session.data.selectedServiceLabel || '',
    });

    const nameResult = normalizeNameInput(cleanedMessage);

    if (!nameResult.isValid) {
      logEarlyReturn('invalid_name', {
        sessionKey,
        input: cleanedMessage,
      });
      return getNameValidationMessage();
    }

    session.data.name = nameResult.value;
    setSessionStep(sessionKey, SESSION_STEPS.AWAITING_DATE);
    await persistSessionState(sessionKey, { lastInboundText: cleanedMessage });
    console.log('[bot][session] saved nextStep=...', {
      sessionKey,
      nextStep: SESSION_STEPS.AWAITING_DATE,
      customerName: session.data.name,
      projectId: getSessionProjectId(session),
    });
    return getDatePromptMessage(routingContext.botProfile, session.data.name);
  }

  if (session.step === SESSION_STEPS.AWAITING_DATE) {
    const dateResult = normalizeDateInput(cleanedMessage);

    if (!dateResult.isValid) {
      logEarlyReturn('invalid_date', {
        sessionKey,
        input: cleanedMessage,
      });
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
      logEarlyReturn('invalid_time', {
        sessionKey,
        input: cleanedMessage,
      });
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
      logEarlyReturn('restart_requested', {
        sessionKey,
        currentStep: session.step,
      });
      return await restartScheduling(
        sessionKey,
        buildSessionContext(from, routingContext),
        routingContext,
      );
    }

    logEarlyReturn('invalid_confirmation_choice', {
      sessionKey,
      input: normalizedMessage,
    });
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
    logEarlyReturn('menu_command', {
      sessionKey,
      projectId: routingContext?.project?.id || null,
    });
    return getWelcomeMenuMessage(botProfile);
  }

  if (isGreeting(textoNormalizado) && (!currentSession || currentSession.step === SESSION_STEPS.MENU)) {
    resetSession(sessionKey, buildSessionContext(from, routingContext));
    await persistSessionState(sessionKey, { lastInboundText: mensagemTexto });
    logEarlyReturn('greeting_menu', {
      sessionKey,
      projectId: routingContext?.project?.id || null,
    });
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
    logEarlyReturn('hours_info', {
      sessionKey,
      projectId: routingContext?.project?.id || null,
    });
    return getHoursMessage(botProfile);
  }

  if (selectedMenuKey === 'address') {
    logEarlyReturn('address_info', {
      sessionKey,
      projectId: routingContext?.project?.id || null,
    });
    return getAddressMessage(botProfile);
  }

  if (selectedMenuKey === 'human') {
    resetSession(sessionKey, buildSessionContext(from, routingContext));
    await persistSessionState(sessionKey, { lastInboundText: mensagemTexto });
    logEarlyReturn('human_handoff', {
      sessionKey,
      projectId: routingContext?.project?.id || null,
    });
    return getTalkToTeamMessage(botProfile);
  }

  logEarlyReturn('conversation_fallback', {
    sessionKey,
    projectId: routingContext?.project?.id || null,
    messageText: mensagemTexto,
  });
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
  const requestTo = String(req.body.To || '').trim();
  const mensagemRecebida = req.body.Body || '';
  const addressing = await resolveIncomingAddressing({
    from,
    requestTo,
  });
  const to = addressing.currentTo;
  const sessionKey = addressing.sessionKey;

  console.log('[webhook] Payload relevante do Twilio:', buildTwilioPayloadLog(req.body));
  console.log('[webhook] Número do remetente:', from);
  console.log('[webhook] Número de destino:', to);
  console.log('[webhook] Mensagem recebida:', mensagemRecebida);
  console.log(`[bot] activeTenant=${ACTIVE_TENANT_SLUG}`);
  logContextResolution('currentTo', to, {
    sessionKey,
    requestTo: normalizeChannelAddress(requestTo),
    addressingSource: addressing.source,
    candidateReason: addressing.candidateReason || null,
    candidateCount: addressing.candidateCount || 0,
  });
  logContextResolution('persistedTo', addressing.persistedTo || null, {
    sessionKey,
    requestTo: normalizeChannelAddress(requestTo),
    addressingSource: addressing.source,
  });

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
      to,
      tenantSlug: ACTIVE_TENANT_SLUG,
    });

    if (devCommandResult.action === 'set_project' && devCommandResult.project) {
      const projectOverride = setSessionProjectOverride(session, devCommandResult.project);
      const tenantSlug = ACTIVE_TENANT_SLUG;

      resetSession(
        sessionKey,
        {
          from,
          to,
          projectId: devCommandResult.project.id,
          tenantSlug,
          devMode: true,
          projectOverrideUsed: true,
          routingSource: 'session_override',
        },
        { preserveProjectOverride: true },
      );

      console.log(`[bot] tenantSelected=${tenantSlug || 'null'}`);
      console.log(`[dev] tenantForced=${ACTIVE_TENANT_SLUG}`, {
        from,
        to,
        sessionKey,
        action: devCommandResult.action,
      });
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
          to,
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
      console.log('[dev] resetApplied', {
        sessionKey,
        from,
        to,
        tenantSlug: ACTIVE_TENANT_SLUG,
        currentStep: sessions[sessionKey]?.step || null,
        selectedServiceKey: sessions[sessionKey]?.data?.selectedServiceKey || '',
        selectedServiceLabel: sessions[sessionKey]?.data?.selectedServiceLabel || '',
        pendingConversationStateCleared: true,
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

  const loadedSession = await loadSessionState(sessionKey, {
    from,
    to,
    tenantSlug: ACTIVE_TENANT_SLUG,
  });
  logContextResolution('sessionTo', loadedSession?.context?.to || null, {
    sessionKey,
    connectionIdentifier: loadedSession?.context?.connectionIdentifier || null,
    projectId: loadedSession?.context?.projectId || null,
  });
  console.log('[bot][session] loaded tenantSlug=... step=...', {
    sessionKey,
    tenantSlug: loadedSession?.tenantSlug || null,
    step: loadedSession?.step || null,
    projectId: getSessionProjectId(loadedSession),
    selectedServiceKey: loadedSession?.data?.selectedServiceKey || '',
    selectedServiceLabel: loadedSession?.data?.selectedServiceLabel || '',
  });

  let routingContext;
  const sessionRoutingReuseDecision = getSessionRoutingReuseDecision(loadedSession, to);
  const shouldReuseSessionRouting = sessionRoutingReuseDecision.canReuse;

  if (!shouldReuseSessionRouting) {
    logMissingContextLink(sessionRoutingReuseDecision.reason, {
      sessionKey,
      from,
      to,
      currentStep: loadedSession?.step || null,
      projectId: sessionRoutingReuseDecision.projectId || null,
      connectionId: sessionRoutingReuseDecision.connectionId || null,
      connectionIdentifier: sessionRoutingReuseDecision.connectionIdentifier || null,
      routingSource: loadedSession?.context?.routingSource || null,
      sessionTo: sessionRoutingReuseDecision.sessionTo || null,
      currentTo: sessionRoutingReuseDecision.currentTo || null,
    });
  }

  if (shouldReuseSessionRouting) {
    try {
      routingContext = await resolveRoutingContextFromSession({
        from,
        to,
        sessionKey,
        session: loadedSession,
      });
    } catch (error) {
      console.error('[routing] Falha ao reutilizar contexto persistido da sessao:', {
        from,
        to,
        code: error.code || null,
        message: error.message,
        projectId: getSessionProjectId(loadedSession),
        activeTenantSlug: ACTIVE_TENANT_SLUG,
      });

      const unavailableTwiml = new twilio.twiml.MessagingResponse();
      unavailableTwiml.message(getChannelUnavailableMessage());

      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(unavailableTwiml.toString());
    }
  } else {
    console.log('[bot][routing] calledDuringStep=true', {
      sessionKey,
      currentStep: loadedSession?.step || null,
      projectId: getSessionProjectId(loadedSession),
      to,
    });

    try {
      console.log('[routing] Iniciando resolução do projeto da conversa:', {
        from,
        to,
        sessionKey,
        connectionIdentifier: loadedSession?.context?.connectionIdentifier || null,
        activeTenantSlug: ACTIVE_TENANT_SLUG,
        hasProjectOverride: Boolean(getSessionProjectOverride(loadedSession)),
      });

      routingContext = await resolveProjectForConversation({
        to,
        session: loadedSession,
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
  }

  logResolvedRoutingContext(sessionKey, from, to, routingContext);

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

  logResolvedBotProfile(sessionKey, from, to, routingContext);

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

  ensureSession(sessionKey, buildSessionContext(from, routingContext));
  logFlow('inboundReceived', {
    sessionKey,
    from,
    to: routingContext.to,
    projectId: routingContext.project.id,
    currentStep: sessions[sessionKey]?.step || null,
    messageText: mensagemRecebida,
  });
  await persistInboundReceivedEvent({
    from,
    messageText: mensagemRecebida,
    sessionKey,
    routingContext,
    session: sessions[sessionKey],
  });
  await persistSessionState(sessionKey, { lastInboundText: mensagemRecebida });

  logCurrentSession(sessionKey);

  // TwiML e o XML que a Twilio entende como instrucao de resposta.
  // Aqui usamos a biblioteca oficial para montar a resposta do WhatsApp.
  const twiml = new twilio.twiml.MessagingResponse();
  let responseMessage;

  try {
    responseMessage = await montarRespostaBot({
      sessionKey,
      from,
      routingContext,
      mensagemTexto: mensagemRecebida,
    });
  } catch (error) {
    console.error('[bot][response] buildFailed', {
      sessionKey,
      message: error.message,
      code: error.code || null,
      currentStep: sessions[sessionKey]?.step || null,
    });
    responseMessage = getConversationFallbackMessage(routingContext.botProfile);
  }

  if (!hasResponseMessage(responseMessage)) {
    logEarlyReturn('empty_response_message', {
      sessionKey,
      currentStep: sessions[sessionKey]?.step || null,
      projectId: routingContext.project?.id || null,
    });
    console.log('[bot][response] built=false', {
      sessionKey,
      currentStep: sessions[sessionKey]?.step || null,
    });
    responseMessage = getConversationFallbackMessage(routingContext.botProfile);
  } else {
    console.log('[bot][response] built=true', {
      sessionKey,
      currentStep: sessions[sessionKey]?.step || null,
      responseLength: responseMessage.length,
    });
  }

  twiml.message(responseMessage);

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
  closeSession,
  createInitialSession,
  ensureSession,
  getSelectedServiceFromSession,
  handleSchedulingFlow,
  isSchedulingStep,
  loadSessionState,
  montarRespostaBot,
  normalizeMessage,
  persistInboundReceivedEvent,
  resetSession,
  resolveProjectServices,
  sessions,
  startScheduling,
};
