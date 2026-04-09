const {
  BOT_RUNTIME_ENV,
  CORE_CONNECTION_TYPE,
  CORE_PROVIDER,
} = require('./config');

const COLLECTION_NAME = 'projectConnections';

function getFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

// O identifier da ProjectConnection representa o endereco do canal de entrada,
// por exemplo "whatsapp:+5534999991111". O bot normaliza esse valor antes da
// busca para manter o roteamento previsivel entre tenants.
function normalizeConnectionIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function isConnectionInactive(connectionData) {
  const normalizedStatus =
    typeof connectionData.status === 'string' ? connectionData.status.toLowerCase() : '';

  return (
    connectionData.active === false ||
    connectionData.isActive === false ||
    (normalizedStatus && normalizedStatus !== 'active')
  );
}

async function findWhatsAppConnectionsByIdentifier(identifier) {
  const { botDb } = getFirestoreClients();
  const normalizedIdentifier = normalizeConnectionIdentifier(identifier);

  if (!normalizedIdentifier) {
    return [];
  }

  let query = botDb
    .collection(COLLECTION_NAME)
    .where('connectionType', '==', CORE_CONNECTION_TYPE)
    .where('provider', '==', CORE_PROVIDER)
    .where('identifier', '==', normalizedIdentifier);

  if (BOT_RUNTIME_ENV) {
    query = query.where('environment', '==', BOT_RUNTIME_ENV);
  }

  const snapshot = await query.get();

  return snapshot.docs.map((connectionDoc) => ({
    id: connectionDoc.id,
    ...connectionDoc.data(),
    identifier: normalizeConnectionIdentifier(connectionDoc.get('identifier')),
  }));
}

async function findWhatsAppConnectionsByTenantSlug(tenantSlug) {
  const { botDb } = getFirestoreClients();
  const normalizedTenantSlug = String(tenantSlug || '').trim().toLowerCase();

  if (!normalizedTenantSlug) {
    return [];
  }

  let query = botDb
    .collection(COLLECTION_NAME)
    .where('connectionType', '==', CORE_CONNECTION_TYPE)
    .where('provider', '==', CORE_PROVIDER)
    .where('tenantSlug', '==', normalizedTenantSlug);

  if (BOT_RUNTIME_ENV) {
    query = query.where('environment', '==', BOT_RUNTIME_ENV);
  }

  const snapshot = await query.get();

  return snapshot.docs.map((connectionDoc) => ({
    id: connectionDoc.id,
    ...connectionDoc.data(),
    identifier: normalizeConnectionIdentifier(connectionDoc.get('identifier')),
  }));
}

module.exports = {
  findWhatsAppConnectionsByTenantSlug,
  findWhatsAppConnectionsByIdentifier,
  isConnectionInactive,
  normalizeConnectionIdentifier,
};
