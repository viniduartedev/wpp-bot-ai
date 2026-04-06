const { CORE_CHANNEL, CORE_SOURCE } = require('./config');
const { normalizeSelectedService } = require('../bot/services');

const COLLECTION_NAME = 'serviceRequests';

function getFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

function buildServiceRequestData(
  { projectId, contactId, requestedDate, requestedTime, service },
  options = {},
) {
  const normalizedService = normalizeSelectedService(service);

  return {
    projectId,
    contactId,
    type: 'appointment',
    channel: CORE_CHANNEL,
    source: CORE_SOURCE,
    requestedDate: String(requestedDate || '').trim(),
    requestedTime: String(requestedTime || '').trim(),
    ...(normalizedService ? { service: normalizedService } : {}),
    status: 'novo',
    createdAt: options.createdAt || null,
  };
}

async function createServiceRequest(
  { projectId, contactId, requestedDate, requestedTime, service },
  options = {},
) {
  const { admin, db } = getFirestoreClients();
  const serviceRequestsRef = db.collection(COLLECTION_NAME);
  const serviceRequestRef = options.docRef || serviceRequestsRef.doc();

  const serviceRequestData = buildServiceRequestData(
    {
      projectId,
      contactId,
      requestedDate,
      requestedTime,
      service,
    },
    {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  );

  if (options.batch) {
    options.batch.set(serviceRequestRef, serviceRequestData);
  } else {
    await serviceRequestRef.set(serviceRequestData);
  }

  return {
    id: serviceRequestRef.id,
    data: serviceRequestData,
  };
}

module.exports = {
  buildServiceRequestData,
  createServiceRequest,
};
