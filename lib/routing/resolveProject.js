const {
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

// O numero de destino do WhatsApp passa a ser a chave de roteamento do bot.
// O bot resolve a ProjectConnection ativa e o Project correspondente antes
// de continuar a conversa; o core segue como camada de observabilidade.
async function resolveProjectByIncomingNumber(to) {
  const connection = await findActiveWhatsAppConnection(to);
  const project = await getProjectFromConnection(connection);

  console.log('[routing] Canal resolvido:', {
    to: connection.identifier,
    connectionId: connection.id,
    projectId: project.id,
  });

  return {
    to: connection.identifier,
    connection,
    project,
    projectOverride: null,
    tenantSlug: resolveProjectTenantSlug(project),
    devMode: false,
    projectOverrideUsed: false,
    routingSource: 'incoming_number',
  };
}

// O Twilio Sandbox gratuito entrega tudo em um unico numero. Em ambiente de
// desenvolvimento/demo, um override por sessao permite simular tenants
// diferentes sem reescrever o roteamento oficial por numero.
async function resolveProjectForConversation({ to, session }) {
  const projectOverride = getSessionProjectOverride(session);

  if (!projectOverride) {
    console.log('[routing] Nenhum override ativo. Aplicando roteamento normal por numero.', {
      to: normalizeConnectionIdentifier(to),
    });

    return resolveProjectByIncomingNumber(to);
  }

  try {
    const project = await getProjectById(projectOverride.projectId);

    console.log('[routing] Override de projeto ativo na sessao.', {
      to: normalizeConnectionIdentifier(to),
      projectId: project.id,
      projectSlug: project.slug || null,
      tenantSlug: resolveProjectTenantSlug(project),
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

    return resolveProjectByIncomingNumber(to);
  }
}

module.exports = {
  ProjectRoutingError,
  findActiveWhatsAppConnection,
  getProjectFromConnection,
  resolveProjectForConversation,
  resolveProjectByIncomingNumber,
};
