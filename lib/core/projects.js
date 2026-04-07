const COLLECTION_NAME = 'projects';
const { ACTIVE_TENANT_SLUG } = require('../tenant');

function getFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

function isProjectInactive(projectData) {
  const normalizedStatus =
    typeof projectData.status === 'string' ? projectData.status.toLowerCase() : '';

  return (
    projectData.active === false ||
    projectData.isActive === false ||
    normalizedStatus === 'inactive'
  );
}

async function getProjectById(projectId) {
  const { botDb } = getFirestoreClients();
  const normalizedProjectId = String(projectId || '').trim();

  if (!normalizedProjectId) {
    throw new Error(
      'ProjectConnection sem projectId valido. Revise o mapeamento do canal antes de continuar.',
    );
  }

  const projectDoc = await botDb.collection(COLLECTION_NAME).doc(normalizedProjectId).get();

  if (!projectDoc.exists) {
    throw new Error(
      `Projeto "${normalizedProjectId}" nao encontrado em "${COLLECTION_NAME}". Revise a ProjectConnection configurada para este canal.`,
    );
  }

  const project = {
    id: projectDoc.id,
    ...projectDoc.data(),
  };

  if (isProjectInactive(project)) {
    throw new Error(
      `Projeto "${normalizedProjectId}" encontrado, mas marcado como inativo. Revise a configuracao do core antes de continuar.`,
    );
  }

  console.log('[core] Projeto resolvido:', {
    projectId: project.id,
    slug: project.slug || null,
    activeTenantSlug: ACTIVE_TENANT_SLUG,
  });

  return project;
}

module.exports = {
  getProjectById,
};
