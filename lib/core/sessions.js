const { CORE_CHANNEL } = require('./config');
const { ACTIVE_TENANT_SLUG } = require('../tenant');

const COLLECTION_NAME = 'sessions';

function getFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

function buildSessionDocumentId(sessionKey) {
  return encodeURIComponent(String(sessionKey || '').trim() || 'unknown-session');
}

function compactObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => compactObject(item)).filter((item) => typeof item !== 'undefined');
  }

  if (!value || typeof value !== 'object') {
    return typeof value === 'undefined' ? undefined : value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, compactObject(item)])
      .filter(([, item]) => typeof item !== 'undefined'),
  );
}

function buildSessionData({ sessionKey, session, status = 'active', lastInboundText = null }) {
  const context = session?.context || {};
  const projectOverride = session?.projectOverride || null;
  const tenantSlug = ACTIVE_TENANT_SLUG;

  return compactObject({
    projectId: context.projectId || projectOverride?.projectId || null,
    tenantSlug,
    channel: CORE_CHANNEL,
    phone: context.from || null,
    to: context.to || null,
    status,
    currentStep: session?.step || null,
    selectedServiceKey: session?.data?.selectedServiceKey || '',
    selectedServiceLabel: session?.data?.selectedServiceLabel || '',
    lastInboundText: lastInboundText === null ? undefined : String(lastInboundText || ''),
    data: session?.data || {},
    context: {
      from: context.from || null,
      to: context.to || null,
      projectId: context.projectId || projectOverride?.projectId || null,
      tenantSlug,
      connectionId: context.connectionId || null,
      connectionIdentifier: context.connectionIdentifier || null,
      botProfileId: context.botProfileId || null,
      botProfileFallbackUsed: context.botProfileFallbackUsed || false,
      botProfileSource: context.botProfileSource || null,
      routingSource: context.routingSource || null,
      devMode: context.devMode || false,
      projectOverrideUsed: context.projectOverrideUsed || false,
    },
    projectOverride: projectOverride
      ? {
          projectId: projectOverride.projectId || null,
          projectSlug: projectOverride.projectSlug || null,
          projectName: projectOverride.projectName || null,
          tenantSlug,
        }
      : null,
  });
}

async function upsertBotSession({ sessionKey, session, status = 'active', lastInboundText = null }) {
  const { admin, botDb } = getFirestoreClients();
  const sessionId = buildSessionDocumentId(sessionKey);
  const sessionData = {
    ...buildSessionData({
      sessionKey,
      session,
      status,
      lastInboundText,
    }),
    sessionKey,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await botDb.collection(COLLECTION_NAME).doc(sessionId).set(sessionData, { merge: true });

  console.log('[bot-runtime] sessionPersisted', {
    sessionId,
    tenantSlug: sessionData.tenantSlug || null,
    currentStep: sessionData.currentStep || null,
    status,
  });

  return {
    id: sessionId,
    data: sessionData,
  };
}

async function getBotSession(sessionKey) {
  const { botDb } = getFirestoreClients();
  const sessionId = buildSessionDocumentId(sessionKey);
  const snapshot = await botDb.collection(COLLECTION_NAME).doc(sessionId).get();

  if (!snapshot.exists) {
    return null;
  }

  const data = snapshot.data() || {};

  return {
    id: snapshot.id,
    data,
  };
}

module.exports = {
  buildSessionData,
  buildSessionDocumentId,
  getBotSession,
  upsertBotSession,
};
