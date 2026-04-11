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

function sanitizeConnectionForLog(connectionData = {}, metadata = {}) {
  return {
    id: connectionData.id || null,
    tenantSlug: connectionData.tenantSlug || null,
    tenantId: connectionData.tenantId || null,
    status: connectionData.status || null,
    direction: connectionData.direction || null,
    connectionType: connectionData.connectionType || null,
    provider: connectionData.provider || null,
    environment: connectionData.environment || null,
    to: normalizeConnectionIdentifier(
      connectionData.identifier || connectionData.to || connectionData.phoneNumber || '',
    ) || null,
    projectId: connectionData.projectId || null,
    targetProjectId: connectionData.targetProjectId || connectionData.projectId || null,
    active: connectionData.active !== false,
    isActive: connectionData.isActive !== false,
    inactiveByRuntimeRule: isConnectionInactive(connectionData),
    ...metadata,
  };
}

function buildMatchMetadata(connectionData) {
  return {
    connectionTypeMatches: connectionData.connectionType === CORE_CONNECTION_TYPE,
    providerMatches: connectionData.provider === CORE_PROVIDER,
    environmentMatches: !BOT_RUNTIME_ENV || connectionData.environment === BOT_RUNTIME_ENV,
  };
}

async function listConnectionsByField(fieldName, fieldValue) {
  const { botDb } = getFirestoreClients();
  const snapshot = await botDb.collection(COLLECTION_NAME).where(fieldName, '==', fieldValue).get();

  return snapshot.docs.map((connectionDoc) => ({
    id: connectionDoc.id,
    ...connectionDoc.data(),
    identifier: normalizeConnectionIdentifier(connectionDoc.get('identifier')),
  }));
}

function logConnectionQuery(label, metadata = {}) {
  console.log(`[routing][query] ${label}`, metadata);
}

async function fetchConnectionsWithFilters({ fieldName, fieldValue, normalizedValue }) {
  const { botDb, firebaseProjectId } = getFirestoreClients();
  const filters = [
    { field: 'connectionType', operator: '==', value: CORE_CONNECTION_TYPE },
    { field: 'provider', operator: '==', value: CORE_PROVIDER },
    { field: fieldName, operator: '==', value: normalizedValue },
  ];

  let query = botDb
    .collection(COLLECTION_NAME)
    .where('connectionType', '==', CORE_CONNECTION_TYPE)
    .where('provider', '==', CORE_PROVIDER)
    .where(fieldName, '==', normalizedValue);

  if (BOT_RUNTIME_ENV) {
    filters.push({ field: 'environment', operator: '==', value: BOT_RUNTIME_ENV });
    query = query.where('environment', '==', BOT_RUNTIME_ENV);
  }

  logConnectionQuery('filters', {
    firebaseProjectId,
    collection: COLLECTION_NAME,
    fieldName,
    fieldValue: normalizedValue,
    runtimeEnvironment: BOT_RUNTIME_ENV || null,
    filters,
  });

  const snapshot = await query.get();
  const connections = snapshot.docs.map((connectionDoc) => ({
    id: connectionDoc.id,
    ...connectionDoc.data(),
    identifier: normalizeConnectionIdentifier(connectionDoc.get('identifier')),
  }));

  logConnectionQuery('matchedDocs', {
    firebaseProjectId,
    fieldName,
    fieldValue: normalizedValue,
    total: connections.length,
    docs: connections.map((connection) => sanitizeConnectionForLog(connection)),
  });

  return {
    firebaseProjectId,
    connections,
  };
}

async function logDiscardedConnections({ fieldName, normalizedValue }) {
  const { firebaseProjectId } = getFirestoreClients();
  const tenantScopedConnections = await listConnectionsByField(fieldName, normalizedValue);

  if (!tenantScopedConnections.length) {
    logConnectionQuery('diagnosticDocs', {
      firebaseProjectId,
      fieldName,
      fieldValue: normalizedValue,
      total: 0,
      docs: [],
    });
    return tenantScopedConnections;
  }

  logConnectionQuery('diagnosticDocs', {
    firebaseProjectId,
    fieldName,
    fieldValue: normalizedValue,
    total: tenantScopedConnections.length,
    docs: tenantScopedConnections.map((connection) =>
      sanitizeConnectionForLog(connection, buildMatchMetadata(connection)),
    ),
  });

  return tenantScopedConnections;
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
  const normalizedIdentifier = normalizeConnectionIdentifier(identifier);

  if (!normalizedIdentifier) {
    return [];
  }

  const { connections } = await fetchConnectionsWithFilters({
    fieldName: 'identifier',
    fieldValue: identifier,
    normalizedValue: normalizedIdentifier,
  });

  if (connections.length > 0 || !BOT_RUNTIME_ENV) {
    return connections;
  }

  const diagnosticConnections = await logDiscardedConnections({
    fieldName: 'identifier',
    normalizedValue: normalizedIdentifier,
  });
  const compatibleIgnoringEnvironment = diagnosticConnections.filter(
    (connection) =>
      connection.connectionType === CORE_CONNECTION_TYPE &&
      connection.provider === CORE_PROVIDER,
  );

  if (compatibleIgnoringEnvironment.length > 0) {
    console.warn('[routing][query] environmentFilterMismatch', {
      fieldName: 'identifier',
      fieldValue: normalizedIdentifier,
      runtimeEnvironment: BOT_RUNTIME_ENV,
      matchedIgnoringEnvironment: compatibleIgnoringEnvironment.map((connection) =>
        sanitizeConnectionForLog(connection, buildMatchMetadata(connection)),
      ),
    });
    return compatibleIgnoringEnvironment;
  }

  return connections;
}

async function findWhatsAppConnectionsByTenantSlug(tenantSlug) {
  const normalizedTenantSlug = String(tenantSlug || '').trim().toLowerCase();

  if (!normalizedTenantSlug) {
    return [];
  }

  const { connections } = await fetchConnectionsWithFilters({
    fieldName: 'tenantSlug',
    fieldValue: tenantSlug,
    normalizedValue: normalizedTenantSlug,
  });

  if (connections.length > 0 || !BOT_RUNTIME_ENV) {
    return connections;
  }

  const diagnosticConnections = await logDiscardedConnections({
    fieldName: 'tenantSlug',
    normalizedValue: normalizedTenantSlug,
  });
  const compatibleIgnoringEnvironment = diagnosticConnections.filter(
    (connection) =>
      connection.connectionType === CORE_CONNECTION_TYPE &&
      connection.provider === CORE_PROVIDER,
  );

  if (compatibleIgnoringEnvironment.length > 0) {
    console.warn('[routing][query] environmentFilterMismatch', {
      fieldName: 'tenantSlug',
      fieldValue: normalizedTenantSlug,
      runtimeEnvironment: BOT_RUNTIME_ENV,
      matchedIgnoringEnvironment: compatibleIgnoringEnvironment.map((connection) =>
        sanitizeConnectionForLog(connection, buildMatchMetadata(connection)),
      ),
    });
    return compatibleIgnoringEnvironment;
  }

  return connections;
}

module.exports = {
  findWhatsAppConnectionsByTenantSlug,
  findWhatsAppConnectionsByIdentifier,
  isConnectionInactive,
  normalizeConnectionIdentifier,
  sanitizeConnectionForLog,
};
