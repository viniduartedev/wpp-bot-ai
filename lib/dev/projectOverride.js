function buildProjectOverride(project) {
  if (!project?.id) {
    return null;
  }

  return {
    projectId: project.id,
    projectSlug: String(project.slug || '').trim() || null,
    projectName: String(project.name || '').trim() || String(project.slug || '').trim() || project.id,
  };
}

function getSessionProjectOverride(session) {
  if (!session?.projectOverride?.projectId) {
    return null;
  }

  return {
    projectId: session.projectOverride.projectId,
    projectSlug: session.projectOverride.projectSlug || null,
    projectName: session.projectOverride.projectName || null,
  };
}

function setSessionProjectOverride(session, project) {
  if (!session) {
    return null;
  }

  const projectOverride = buildProjectOverride(project);
  session.projectOverride = projectOverride;

  return projectOverride;
}

function clearSessionProjectOverride(session) {
  const previousOverride = getSessionProjectOverride(session);

  if (session) {
    session.projectOverride = null;
  }

  return previousOverride;
}

function buildProjectOverrideRoutingContext({ to, project, projectOverride }) {
  // Em modo dev/demo o projeto vem da sessao atual; o roteamento normal por
  // numero continua sendo a regra padrao quando nenhum override esta ativo.
  return {
    to: String(to || '').trim().toLowerCase() || null,
    connection: null,
    project,
    projectOverride,
    devMode: true,
    projectOverrideUsed: true,
    routingSource: 'session_override',
  };
}

module.exports = {
  buildProjectOverrideRoutingContext,
  clearSessionProjectOverride,
  getSessionProjectOverride,
  setSessionProjectOverride,
};
