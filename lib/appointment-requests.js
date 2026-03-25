const COLLECTION_NAME = 'appointmentRequests';

function getFirestoreClients() {
  return require('./firebase-admin');
}

// O painel administrativo em outro projeto podera ler esta colecao depois.
// Aqui persistimos apenas a solicitacao final do agendamento para manter
// o bot simples e didatico enquanto o estado da conversa segue em memoria.
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
