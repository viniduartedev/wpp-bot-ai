const { CORE_CHANNEL, CORE_SOURCE } = require('./config');

const COLLECTION_NAME = 'inboundEvents';

function getFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

async function logInboundEvent(
  { phone, projectId = null, eventType, status, metadata = {} },
  options = {},
) {
  const { admin, botDb } = getFirestoreClients();
  const inboundEventsRef = botDb.collection(COLLECTION_NAME);
  const inboundEventRef = options.docRef || inboundEventsRef.doc();

  const inboundEventData = {
    channel: CORE_CHANNEL,
    source: CORE_SOURCE,
    phone: String(phone || '').trim(),
    projectId: projectId || null,
    eventType,
    status,
    metadata,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (options.batch) {
    options.batch.set(inboundEventRef, inboundEventData);
  } else {
    await inboundEventRef.set(inboundEventData);
  }

  return {
    id: inboundEventRef.id,
    data: inboundEventData,
  };
}

module.exports = {
  logInboundEvent,
};
