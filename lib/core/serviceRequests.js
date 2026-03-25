const { CORE_CHANNEL, CORE_SOURCE } = require('./config');

const COLLECTION_NAME = 'serviceRequests';

function getFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

async function createServiceRequest(
  { projectId, contactId, requestedDate, requestedTime },
  options = {},
) {
  const { admin, db } = getFirestoreClients();
  const serviceRequestsRef = db.collection(COLLECTION_NAME);
  const serviceRequestRef = options.docRef || serviceRequestsRef.doc();

  const serviceRequestData = {
    projectId,
    contactId,
    type: 'appointment',
    channel: CORE_CHANNEL,
    source: CORE_SOURCE,
    requestedDate: String(requestedDate || '').trim(),
    requestedTime: String(requestedTime || '').trim(),
    status: 'novo',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

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
  createServiceRequest,
};
