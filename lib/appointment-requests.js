const COLLECTION_NAME = 'appointmentRequests';

function getFirestoreClients() {
  return require('./firebase-admin').getFirestoreClients();
}

// appointmentRequests passa a ser legado temporario.
// A estrutura principal do bot integrado ao core oficial agora e:
// contacts + serviceRequests + inboundEvents.
// Mantemos este helper apenas como referencia historica ate a migracao
// completa, mas ele nao deve mais ser usado como fluxo principal.
async function saveAppointmentRequest(data) {
  const { admin, db } = getFirestoreClients();

  return db.collection(COLLECTION_NAME).add({
    phone: data.phone,
    customerName: data.customerName,
    requestedDate: data.requestedDate,
    requestedTime: data.requestedTime,
    status: 'novo',
    channel: 'whatsapp',
    source: 'twilio-sandbox',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = {
  saveAppointmentRequest,
};
