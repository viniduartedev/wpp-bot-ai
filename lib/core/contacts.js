const { CORE_CHANNEL } = require('./config');

const COLLECTION_NAME = 'contacts';

function getFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

async function findOrCreateContact({ projectId, phone, name }) {
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
    const updates = {
      lastInteractionAt: serverTimestamp,
    };

    if (normalizedName && contactDoc.get('name') !== normalizedName) {
      updates.name = normalizedName;
    }

    await contactDoc.ref.set(updates, { merge: true });

    console.log('[core] Contact encontrado:', {
      contactId: contactDoc.id,
      projectId,
      phone: normalizedPhone,
    });

    return {
      id: contactDoc.id,
      ...contactDoc.data(),
      ...updates,
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

  const createdContactRef = await contactsRef.add(contactData);

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
};
