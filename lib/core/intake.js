const { getFirestoreClients } = require('../firebase-admin');
const { findOrCreateContact } = require('./contacts');
const { logInboundEvent } = require('./inboundEvents');
const { getDefaultProject } = require('./projects');
const { createServiceRequest } = require('./serviceRequests');

// O bot agora registra entradas no core oficial via contacts + serviceRequests.
// inboundEvents prepara a observabilidade operacional do canal WhatsApp e um
// futuro dashboard do bot. Em etapas futuras, este mesmo canal tambem podera
// atuar em saida para confirmacoes, lembretes e outros avisos disparados pelo core.
async function registerAppointmentServiceRequest({
  phone,
  name,
  requestedDate,
  requestedTime,
}) {
  const { db } = getFirestoreClients();
  let project = null;

  try {
    project = await getDefaultProject();

    const contact = await findOrCreateContact({
      projectId: project.id,
      phone,
      name,
    });

    const batch = db.batch();

    const serviceRequest = await createServiceRequest(
      {
        projectId: project.id,
        contactId: contact.id,
        requestedDate,
        requestedTime,
      },
      { batch },
    );

    const inboundEvent = await logInboundEvent(
      {
        phone,
        projectId: project.id,
        eventType: 'service_request_created',
        status: 'processed',
        metadata: {
          contactId: contact.id,
          serviceRequestId: serviceRequest.id,
        },
      },
      { batch },
    );

    await batch.commit();

    console.log('[core] ServiceRequest criada:', {
      serviceRequestId: serviceRequest.id,
      projectId: project.id,
      contactId: contact.id,
    });

    console.log('[core] InboundEvent salvo:', {
      inboundEventId: inboundEvent.id,
      eventType: 'service_request_created',
      projectId: project.id,
      phone,
    });

    return {
      project,
      contact,
      serviceRequest,
      inboundEvent,
    };
  } catch (error) {
    if (project?.id && !error.projectId) {
      error.projectId = project.id;
    }

    throw error;
  }
}

async function logAppointmentRegistrationFailure({ phone, projectId = null, error }) {
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

module.exports = {
  registerAppointmentServiceRequest,
  logAppointmentRegistrationFailure,
};
