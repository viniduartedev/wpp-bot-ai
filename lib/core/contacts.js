const { CORE_CHANNEL } = require('./config');

const COLLECTION_NAME = 'contacts';

function getFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

async function findOrCreateContact({ projectId, phone, name }) {
  return upsertContact({ projectId, phone, name });
}

async function upsertContact({ projectId, phone, name }, options = {}) {
  const { admin, botDb } = getFirestoreClients();
  const normalizedPhone = String(phone || '').trim();
  const normalizedName = String(name || '').trim();
  const contactsRef = botDb.collection(COLLECTION_NAME);

  const existingContactSnapshot = await contactsRef
    .where('projectId', '==', projectId)
    .where('phone', '==', normalizedPhone)
    .limit(1)
    .get();

  const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();

  if (!existingContactSnapshot.empty) {
    const contactDoc = existingContactSnapshot.docs[0];
    const contactData = {
      projectId: contactDoc.get('projectId') || projectId,
      channel: contactDoc.get('channel') || CORE_CHANNEL,
      phone: normalizedPhone,
      name: normalizedName || String(contactDoc.get('name') || '').trim(),
      createdAt: contactDoc.get('createdAt') || serverTimestamp,
      lastInteractionAt: serverTimestamp,
    };

    if (options.batch) {
      options.batch.set(contactDoc.ref, contactData, { merge: true });
    } else {
      await contactDoc.ref.set(contactData, { merge: true });
    }

    console.log('[core] Contact encontrado:', {
      contactId: contactDoc.id,
      projectId,
      phone: normalizedPhone,
    });

    return {
      id: contactDoc.id,
      ...contactData,
      wasCreated: false,
    };
  }

  const contactData = {
    projectId,
    channel: CORE_CHANNEL,
    phone: normalizedPhone,
    name: normalizedName,
    createdAt: serverTimestamp,
    lastInteractionAt: serverTimestamp,
  };

  const createdContactRef = options.docRef || contactsRef.doc();

  if (options.batch) {
    options.batch.set(createdContactRef, contactData, { merge: true });
  } else {
    await createdContactRef.set(contactData, { merge: true });
  }

  console.log('[core] Contact criado:', {
    contactId: createdContactRef.id,
    projectId,
    phone: normalizedPhone,
  });

  return {
    id: createdContactRef.id,
    ...contactData,
    wasCreated: true,
  };
}

module.exports = {
  findOrCreateContact,
  upsertContact,
};
