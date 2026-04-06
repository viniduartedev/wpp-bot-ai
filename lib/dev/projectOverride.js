function normalizeTenantSlug(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();
  return normalizedValue || null;
}

function resolveProjectTenantSlug(project) {
  return normalizeTenantSlug(project?.tenantSlug || project?.slug);
}

function buildProjectOverride(project) {
  if (!project?.id) {
    return null;
  }

  const tenantSlug = resolveProjectTenantSlug(project);

  return {
    projectId: project.id,
    projectSlug: String(project.slug || '').trim() || null,
    tenantSlug,
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
    tenantSlug:
      normalizeTenantSlug(
        session.projectOverride.tenantSlug || session.projectOverride.projectSlug || session.tenantSlug,
      ) || null,
    projectName: session.projectOverride.projectName || null,
  };
}

function setSessionProjectOverride(session, project) {
  if (!session) {
    return null;
  }

  const projectOverride = buildProjectOverride(project);
  session.projectOverride = projectOverride;
  session.tenantSlug = projectOverride?.tenantSlug || null;

  return projectOverride;
}

function clearSessionProjectOverride(session) {
  const previousOverride = getSessionProjectOverride(session);

  if (session) {
    session.projectOverride = null;
    session.tenantSlug = null;
  }

  return previousOverride;
}

function buildProjectOverrideRoutingContext({ to, project, projectOverride }) {
  const tenantSlug = normalizeTenantSlug(
    projectOverride?.tenantSlug || project?.tenantSlug || project?.slug,
  );

  // Em modo dev/demo o projeto vem da sessao atual; o roteamento normal por
  // numero continua sendo a regra padrao quando nenhum override esta ativo.
  return {
    to: String(to || '').trim().toLowerCase() || null,
    connection: null,
    project,
    projectOverride,
    tenantSlug,
    devMode: true,
    projectOverrideUsed: true,
    routingSource: 'session_override',
  };
}

module.exports = {
  buildProjectOverrideRoutingContext,
  clearSessionProjectOverride,
  getSessionProjectOverride,
  normalizeTenantSlug,
  resolveProjectTenantSlug,
  setSessionProjectOverride,
};
