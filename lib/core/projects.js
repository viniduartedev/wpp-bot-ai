const { DEFAULT_PROJECT_SLUG } = require('./config');

const COLLECTION_NAME = 'projects';

function getFirestoreClients() {
  return require('../firebase-admin').getFirestoreClients();
}

function isProjectInactive(projectData) {
  return (
    projectData.active === false ||
    projectData.isActive === false ||
    projectData.status === 'inactive'
  );
}

async function getDefaultProject() {
  const { db } = getFirestoreClients();
  const projectSlug = DEFAULT_PROJECT_SLUG;

  const snapshot = await db
    .collection(COLLECTION_NAME)
    .where('slug', '==', projectSlug)
    .limit(1)
    .get();

  if (snapshot.empty) {
    throw new Error(
      `Projeto padrao nao encontrado em "${COLLECTION_NAME}" para o slug "${projectSlug}". Ajuste DEFAULT_PROJECT_SLUG ou cadastre esse projeto no core.`,
    );
  }

  const projectDoc = snapshot.docs[0];
  const project = {
    id: projectDoc.id,
    ...projectDoc.data(),
  };

  if (isProjectInactive(project)) {
    throw new Error(
      `Projeto "${projectSlug}" encontrado, mas marcado como inativo. Revise a configuracao do core antes de continuar.`,
    );
  }

  console.log('[core] Projeto resolvido:', {
    projectId: project.id,
    slug: project.slug || projectSlug,
  });

  return project;
}

module.exports = {
  getDefaultProject,
};
