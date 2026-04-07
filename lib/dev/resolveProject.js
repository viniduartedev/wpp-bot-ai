const { getFirestoreClients } = require('../firebase-admin');
const { DEV_PROJECT_ALIASES, normalizeDevText } = require('./config');
const { ACTIVE_TENANT_SLUG } = require('../tenant');

const PROJECT_COLLECTION_NAME = 'projects';

function isProjectInactive(projectData) {
  const normalizedStatus =
    typeof projectData.status === 'string' ? projectData.status.toLowerCase() : '';

  return (
    projectData.active === false ||
    projectData.isActive === false ||
    normalizedStatus === 'inactive'
  );
}

async function findProjectBySlug(slug) {
  const normalizedSlug = normalizeDevText(slug);

  if (!normalizedSlug) {
    return null;
  }

  if (normalizedSlug !== ACTIVE_TENANT_SLUG) {
    return null;
  }

  const { botDb } = getFirestoreClients();
  const snapshot = await botDb
    .collection(PROJECT_COLLECTION_NAME)
    .where('slug', '==', normalizedSlug)
    .limit(2)
    .get();

  if (snapshot.empty) {
    return null;
  }

  if (snapshot.size > 1) {
    const error = new Error(
      `Mais de um projeto encontrado para o slug "${normalizedSlug}". Revise a base antes de usar o modo dev.`,
    );
    error.code = 'dev_project_duplicate';
    error.projectSlug = normalizedSlug;
    throw error;
  }

  const projectDoc = snapshot.docs[0];
  const project = {
    id: projectDoc.id,
    ...projectDoc.data(),
  };

  if (isProjectInactive(project)) {
    const error = new Error(
      `Projeto "${normalizedSlug}" encontrado, mas marcado como inativo para o modo dev.`,
    );
    error.code = 'dev_project_inactive';
    error.projectId = project.id;
    error.projectSlug = normalizedSlug;
    throw error;
  }

  return project;
}

async function resolveProjectByDevInput(input) {
  const normalizedInput = normalizeDevText(input);

  if (!normalizedInput) {
    return null;
  }

  // Alias amigavel tem prioridade no modo demo para evitar depender do slug
  // tecnico. Se nao resolver, o fallback continua sendo o slug exato.
  const aliasedSlug = DEV_PROJECT_ALIASES[normalizedInput];

  if (aliasedSlug) {
    const projectByAlias = await findProjectBySlug(aliasedSlug);

    if (projectByAlias) {
      return {
        project: projectByAlias,
        matchedBy: 'alias',
        lookupValue: normalizedInput,
        resolvedSlug: aliasedSlug,
      };
    }
  }

  if (normalizedInput !== ACTIVE_TENANT_SLUG) {
    return null;
  }

  const projectBySlug = await findProjectBySlug(normalizedInput);

  if (!projectBySlug) {
    return null;
  }

  return {
    project: projectBySlug,
    matchedBy: 'slug',
    lookupValue: normalizedInput,
    resolvedSlug: normalizedInput,
  };
}

module.exports = {
  PROJECT_COLLECTION_NAME,
  findProjectBySlug,
  isProjectInactive,
  resolveProjectByDevInput,
};
