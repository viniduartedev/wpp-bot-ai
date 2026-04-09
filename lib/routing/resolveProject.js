const {
  findWhatsAppConnectionsByTenantSlug,
  findWhatsAppConnectionsByIdentifier,
  isConnectionInactive,
  normalizeConnectionIdentifier,
} = require('../core/projectConnections');
const { getProjectById } = require('../core/projects');
const {
  buildProjectOverrideRoutingContext,
  clearSessionProjectOverride,
  getSessionProjectOverride,
  resolveProjectTenantSlug,
} = require('../dev/projectOverride');
const { ACTIVE_TENANT_SLUG, normalizeTenantSlug } = require('../tenant');

class ProjectRoutingError extends Error {
  constructor(code, message, metadata = {}) {
    super(message);
    this.name = 'ProjectRoutingError';
    this.code = code;

    Object.assign(this, metadata);
  }
}

async function findActiveWhatsAppConnection(to) {
  const normalizedTo = normalizeConnectionIdentifier(to);

  if (!normalizedTo) {
    throw new ProjectRoutingError(
      'invalid_destination',
      'Numero de destino do webhook nao informado.',
      { to: null },
    );
  }

  const connections = await findWhatsAppConnectionsByIdentifier(normalizedTo);

  if (!connections.length) {
    throw new ProjectRoutingError(
      'connection_not_found',
      `Nenhuma ProjectConnection encontrada para o numero "${normalizedTo}".`,
      { to: normalizedTo },
    );
  }

  if (connections.length > 1) {
    throw new ProjectRoutingError(
      'connection_duplicate',
      `Mais de uma ProjectConnection encontrada para o numero "${normalizedTo}". Revise a configuracao do canal.`,
      {
        to: normalizedTo,
        connectionIds: connections.map((connection) => connection.id),
      },
    );
  }

  const connection = connections[0];

  if (isConnectionInactive(connection)) {
    throw new ProjectRoutingError(
      'connection_inactive',
      `ProjectConnection "${connection.id}" encontrada para o numero "${normalizedTo}", mas marcada como inativa.`,
      {
        to: normalizedTo,
        connectionId: connection.id,
        projectId: connection.projectId || null,
      },
    );
  }

  if (!connection.projectId) {
    throw new ProjectRoutingError(
      'connection_missing_project',
      `ProjectConnection "${connection.id}" sem projectId valido para o numero "${normalizedTo}".`,
      {
        to: normalizedTo,
        connectionId: connection.id,
      },
    );
  }

  return connection;
}

async function findFallbackConnectionByTenantSlug({ tenantSlug, to }) {
  const normalizedTenantSlug = normalizeTenantSlug(tenantSlug);
  const normalizedTo = normalizeConnectionIdentifier(to);

  if (!normalizedTenantSlug) {
    return null;
  }

  const connections = await findWhatsAppConnectionsByTenantSlug(normalizedTenantSlug);
  const activeConnections = connections.filter((connection) => !isConnectionInactive(connection));

  if (activeConnections.length !== 1) {
    throw new ProjectRoutingError(
      'fallback_connection_ambiguous',
      `Fallback por tenant "${normalizedTenantSlug}" encontrou ${activeConnections.length} conexoes ativas.`,
      {
        to: normalizedTo,
        tenantSlug: normalizedTenantSlug,
        connectionIds: activeConnections.map((connection) => connection.id),
      },
    );
  }

  return activeConnections[0];
}

async function getProjectFromConnection(connection) {
  try {
    return await getProjectById(connection.projectId);
  } catch (error) {
    const routingError = new ProjectRoutingError(
      'project_not_available',
      error.message,
      {
        to: connection.identifier || null,
        connectionId: connection.id,
        projectId: connection.projectId || null,
      },
    );

    routingError.cause = error;
    throw routingError;
  }
}

function assertActiveTenantProject(project, metadata = {}) {
  const projectTenantSlug = normalizeTenantSlug(project?.tenantSlug || project?.slug);

  if (projectTenantSlug === ACTIVE_TENANT_SLUG) {
    return;
  }

  throw new ProjectRoutingError(
    'tenant_not_supported',
    `O runtime piloto do bot esta disponivel apenas para "${ACTIVE_TENANT_SLUG}".`,
    {
      ...metadata,
      projectId: project?.id || metadata.projectId || null,
      projectSlug: project?.slug || null,
      tenantSlug: projectTenantSlug || null,
      activeTenantSlug: ACTIVE_TENANT_SLUG,
    },
  );
}

// O numero de destino do WhatsApp passa a ser a chave de roteamento do bot.
// O bot resolve a ProjectConnection ativa e o Project correspondente antes
// de continuar a conversa; o core segue como camada de observabilidade.
async function resolveProjectByIncomingNumber(to, options = {}) {
  const normalizedTo = normalizeConnectionIdentifier(to);
  const requestedTenantSlug = normalizeTenantSlug(options.tenantSlug || ACTIVE_TENANT_SLUG);

  console.log('[routing] strictLookup start', {
    to: normalizedTo,
    requestedTenantSlug,
    activeTenantSlug: ACTIVE_TENANT_SLUG,
  });

  let connection;
  let usedTenantFallback = false;

  try {
    connection = await findActiveWhatsAppConnection(to);
  } catch (error) {
    console.warn('[routing] strictLookup miss', {
      to: normalizedTo,
      requestedTenantSlug,
      code: error.code || null,
      message: error.message,
      activeTenantSlug: ACTIVE_TENANT_SLUG,
    });

    const shouldTryFallback =
      error.code === 'connection_not_found' && requestedTenantSlug === ACTIVE_TENANT_SLUG;

    if (!shouldTryFallback) {
      throw error;
    }

    connection = await findFallbackConnectionByTenantSlug({
      tenantSlug: requestedTenantSlug,
      to,
    });
    usedTenantFallback = true;

    console.warn('[routing] fallbackLookup hit', {
      to: normalizedTo,
      requestedTenantSlug,
      connectionId: connection.id,
      connectionIdentifier: connection.identifier || null,
      activeTenantSlug: ACTIVE_TENANT_SLUG,
    });
  }

  const project = await getProjectFromConnection(connection);
  assertActiveTenantProject(project, {
    to: connection.identifier || null,
    connectionId: connection.id,
  });

  console.log('[routing] Canal resolvido:', {
    to: connection.identifier,
    connectionId: connection.id,
    projectId: project.id,
    tenantSlug: ACTIVE_TENANT_SLUG,
  });

  return {
    to: connection.identifier,
    connection,
    project,
    projectOverride: null,
    tenantSlug: resolveProjectTenantSlug(project),
    devMode: false,
    projectOverrideUsed: false,
    routingSource: usedTenantFallback ? 'tenant_fallback' : 'incoming_number',
  };
}

// O Twilio Sandbox gratuito entrega tudo em um unico numero. Nesta fase, o
// override de dev só pode apontar para o tenant piloto clinica-devtec.
async function resolveProjectForConversation({ to, session }) {
  const projectOverride = getSessionProjectOverride(session);

  if (!projectOverride) {
    console.log('[routing] Nenhum override ativo. Aplicando roteamento normal por numero.', {
      to: normalizeConnectionIdentifier(to),
    });

    return resolveProjectByIncomingNumber(to, {
      tenantSlug: ACTIVE_TENANT_SLUG,
    });
  }

  try {
    const project = await getProjectById(projectOverride.projectId);
    assertActiveTenantProject(project, {
      to: normalizeConnectionIdentifier(to),
      projectId: projectOverride.projectId,
    });

    console.log('[routing] Override de projeto ativo na sessao.', {
      to: normalizeConnectionIdentifier(to),
      projectId: project.id,
      projectSlug: project.slug || null,
      tenantSlug: ACTIVE_TENANT_SLUG,
      projectName: project.name || null,
    });

    return buildProjectOverrideRoutingContext({
      to,
      project,
      projectOverride,
    });
  } catch (error) {
    clearSessionProjectOverride(session);

    console.warn('[routing] Override invalido removido da sessao. Voltando ao roteamento normal.', {
      to: normalizeConnectionIdentifier(to),
      projectId: projectOverride.projectId,
      projectSlug: projectOverride.projectSlug || null,
      message: error.message,
    });

    return resolveProjectByIncomingNumber(to, {
      tenantSlug: ACTIVE_TENANT_SLUG,
    });
  }
}

module.exports = {
  ProjectRoutingError,
  findActiveWhatsAppConnection,
  getProjectFromConnection,
  resolveProjectForConversation,
  resolveProjectByIncomingNumber,
};
