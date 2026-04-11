const { upsertContact } = require('./contacts');
const { logInboundEvent } = require('./inboundEvents');
const { createServiceRequest } = require('./serviceRequests');
const { ACTIVE_TENANT_SLUG } = require('../tenant');

function getBotFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

// O bot agora registra entradas no core oficial via contacts + serviceRequests.
// inboundEvents prepara a observabilidade operacional do canal WhatsApp e um
// futuro dashboard do bot. Em etapas futuras, este mesmo canal tambem podera
// atuar em saida para confirmacoes, lembretes e outros avisos disparados pelo core.
// O routingContext ja chega resolvido pelo numero de destino do canal, para que
// cada registro seja criado no projectId correto sem depender de fallback fixo.
async function registerAppointmentServiceRequest({
  phone,
  name,
  requestedDate,
  requestedTime,
  sessionId,
  tenantSlug,
  service,
  routingContext,
}) {
  const { botDb } = getBotFirestoreClients();
  const project = routingContext?.project || null;
  const connection = routingContext?.connection || null;
  const channelAddress = String(routingContext?.to || '').trim();
  const resolvedTenantSlug = ACTIVE_TENANT_SLUG;

  if (!project?.id) {
    const error = new Error(
      'Projeto nao resolvido para registrar a solicitacao. O bot deve sempre rotear a conversa antes do intake.',
    );
    error.code = 'project_not_resolved';
    throw error;
  }

  try {
    console.log('[core] Registrando solicitacao no projeto roteado:', {
      projectId: project.id,
      tenantSlug: resolvedTenantSlug,
      connectionId: connection?.id || null,
      phone,
      to: channelAddress || null,
      service,
    });

    const batch = botDb.batch();
    const contact = await upsertContact(
      {
        projectId: project.id,
        phone,
        name,
      },
      { batch },
    );

    const serviceRequest = await createServiceRequest(
      {
        projectId: project.id,
        tenantSlug: resolvedTenantSlug,
        contactId: contact.id,
        sessionId,
        requestedDate,
        requestedTime,
        service,
      },
      { batch },
    );
    const persistedService = serviceRequest.data.service || null;

    const inboundEvent = await logInboundEvent(
      {
        phone,
        projectId: project.id,
        eventType: 'service_request_created',
        status: 'processed',
        metadata: {
          contactId: contact.id,
          sessionId: sessionId || null,
          serviceRequestId: serviceRequest.id,
          connectionId: connection?.id || null,
          connectionIdentifier: connection?.identifier || channelAddress || null,
          to: channelAddress || null,
          tenantSlug: resolvedTenantSlug,
          botProfileId: routingContext?.botProfile?.id || null,
          botProfileFallbackUsed: routingContext?.botProfile?.fallbackUsed || false,
          botProfileSource: routingContext?.botProfile?.source || null,
          service: persistedService,
        },
      },
      { batch },
    );

    await batch.commit();

    console.log('[core] ServiceRequest criada:', {
      serviceRequestId: serviceRequest.id,
      projectId: project.id,
      tenantSlug: resolvedTenantSlug,
      contactId: contact.id,
      sessionId: sessionId || null,
      service: persistedService,
    });

    console.log('[core] InboundEvent salvo:', {
      inboundEventId: inboundEvent.id,
      eventType: 'service_request_created',
      projectId: project.id,
      phone,
    });

    return {
      project,
      connection,
      contact,
      serviceRequest,
      inboundEvent,
    };
  } catch (error) {
    if (project?.id && !error.projectId) {
      error.projectId = project.id;
    }

    if (connection?.id && !error.connectionId) {
      error.connectionId = connection.id;
    }

    if (channelAddress && !error.to) {
      error.to = channelAddress;
    }

    throw error;
  }
}

async function logAppointmentRegistrationFailure({
  phone,
  projectId = null,
  error,
  metadata = {},
}) {
  const errorMessage =
    error instanceof Error ? error.message : String(error || 'Erro desconhecido');

  try {
    const inboundEvent = await logInboundEvent({
      phone,
      projectId,
      eventType: 'service_request_create_failed',
      status: 'error',
      metadata: {
        errorMessage,
        ...metadata,
      },
    });

    console.log('[core] InboundEvent de erro salvo:', {
      inboundEventId: inboundEvent.id,
      eventType: 'service_request_create_failed',
      projectId,
      phone,
    });
  } catch (inboundEventError) {
    console.error('[core] Falha ao salvar inboundEvent de erro:', inboundEventError);
  }
}

async function logProjectRoutingFailure({ phone, to, error, metadata = {} }) {
  const errorMessage =
    error instanceof Error ? error.message : String(error || 'Erro desconhecido');

  try {
    const inboundEvent = await logInboundEvent({
      phone,
      projectId: error?.projectId || null,
      eventType: 'channel_routing_failed',
      status: 'error',
      metadata: {
        to: String(to || '').trim() || null,
        errorCode: error?.code || null,
        errorMessage,
        connectionId: error?.connectionId || null,
        ...metadata,
      },
    });

    console.log('[core] InboundEvent de erro de roteamento salvo:', {
      inboundEventId: inboundEvent.id,
      eventType: 'channel_routing_failed',
      projectId: error?.projectId || null,
      phone,
      to,
    });
  } catch (inboundEventError) {
    console.error('[core] Falha ao salvar inboundEvent de erro de roteamento:', inboundEventError);
  }
}

async function logBotProfileResolutionFailure({
  phone,
  to,
  projectId = null,
  botProfileId = null,
  error,
  metadata = {},
}) {
  const errorMessage =
    error instanceof Error ? error.message : String(error || 'Erro desconhecido');

  try {
    const inboundEvent = await logInboundEvent({
      phone,
      projectId,
      eventType: 'bot_profile_unavailable',
      status: 'error',
      metadata: {
        to: String(to || '').trim() || null,
        botProfileId: botProfileId || null,
        errorCode: error?.code || null,
        errorMessage,
        ...metadata,
      },
    });

    console.log('[core] InboundEvent de erro de BotProfile salvo:', {
      inboundEventId: inboundEvent.id,
      eventType: 'bot_profile_unavailable',
      projectId,
      phone,
      to,
      botProfileId,
    });
  } catch (inboundEventError) {
    console.error('[core] Falha ao salvar inboundEvent de erro de BotProfile:', inboundEventError);
  }
}

module.exports = {
  logBotProfileResolutionFailure,
  logProjectRoutingFailure,
  registerAppointmentServiceRequest,
  logAppointmentRegistrationFailure,
};
