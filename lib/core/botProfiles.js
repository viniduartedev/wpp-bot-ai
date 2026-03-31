const COLLECTION_NAME = 'botProfiles';

function getFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

class BotProfileResolutionError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'BotProfileResolutionError';
    this.code = code;

    Object.assign(this, metadata);
  }
}

function isBotProfileInactive(botProfileData) {
  const normalizedStatus =
    typeof botProfileData.status === 'string' ? botProfileData.status.toLowerCase() : '';

  return (
    botProfileData.active === false ||
    botProfileData.isActive === false ||
    normalizedStatus === 'inactive'
  );
}

async function getBotProfileByProject(projectId) {
  const { db } = getFirestoreClients();
  const normalizedProjectId = String(projectId || '').trim();

  if (!normalizedProjectId) {
    throw new BotProfileResolutionError(
      'bot_profile_missing_project',
      'ProjectId nao informado para buscar BotProfile.',
      { projectId: null },
    );
  }

  const profileByIdDoc = await db.collection(COLLECTION_NAME).doc(normalizedProjectId).get();

  if (profileByIdDoc.exists) {
    const botProfile = {
      id: profileByIdDoc.id,
      ...profileByIdDoc.data(),
    };

    console.log('[bot-profile] BotProfile resolvido por id do projeto:', {
      botProfileId: botProfile.id,
      projectId: normalizedProjectId,
      active: botProfile.active !== false,
    });

    return botProfile;
  }

  const snapshot = await db
    .collection(COLLECTION_NAME)
    .where('projectId', '==', normalizedProjectId)
    .limit(2)
    .get();

  if (snapshot.empty) {
    return null;
  }

  if (snapshot.size > 1) {
    throw new BotProfileResolutionError(
      'bot_profile_duplicate',
      `Mais de um BotProfile encontrado para o projeto "${normalizedProjectId}". Revise a configuracao do Core.`,
      {
        projectId: normalizedProjectId,
        botProfileIds: snapshot.docs.map((profileDoc) => profileDoc.id),
      },
    );
  }

  const profileDoc = snapshot.docs[0];
  const botProfile = {
    id: profileDoc.id,
    ...profileDoc.data(),
  };

  console.log('[bot-profile] BotProfile resolvido por campo projectId:', {
    botProfileId: botProfile.id,
    projectId: normalizedProjectId,
    active: botProfile.active !== false,
  });

  return botProfile;
}

module.exports = {
  BotProfileResolutionError,
  getBotProfileByProject,
  isBotProfileInactive,
};
