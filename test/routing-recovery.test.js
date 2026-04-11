const test = require('node:test');
const assert = require('node:assert/strict');

const targetModulePath = require.resolve('../lib/routing/resolveProject');
const projectConnectionsModulePath = require.resolve('../lib/core/projectConnections');
const projectsModulePath = require.resolve('../lib/core/projects');
const projectOverrideModulePath = require.resolve('../lib/dev/projectOverride');
const tenantModulePath = require.resolve('../lib/tenant');

const originalRoutingModule = require.cache[targetModulePath];
const originalProjectConnectionsModule = require.cache[projectConnectionsModulePath];
const originalProjectsModule = require.cache[projectsModulePath];
const originalProjectOverrideModule = require.cache[projectOverrideModulePath];
const originalTenantModule = require.cache[tenantModulePath];

function restoreModule(modulePath, originalModule) {
  if (originalModule) {
    require.cache[modulePath] = originalModule;
    return;
  }

  delete require.cache[modulePath];
}

function restoreAllModules() {
  restoreModule(targetModulePath, originalRoutingModule);
  restoreModule(projectConnectionsModulePath, originalProjectConnectionsModule);
  restoreModule(projectsModulePath, originalProjectsModule);
  restoreModule(projectOverrideModulePath, originalProjectOverrideModule);
  restoreModule(tenantModulePath, originalTenantModule);
}

function loadRoutingWithMocks({
  connectionsByIdentifier = [],
  connectionsByTenantSlug = [],
  projectById,
} = {}) {
  delete require.cache[targetModulePath];

  require.cache[projectConnectionsModulePath] = {
    id: projectConnectionsModulePath,
    filename: projectConnectionsModulePath,
    loaded: true,
    exports: {
      findWhatsAppConnectionsByIdentifier: async () => connectionsByIdentifier,
      findWhatsAppConnectionsByTenantSlug: async () => connectionsByTenantSlug,
      isConnectionInactive: (connection) => connection?.active === false,
      normalizeConnectionIdentifier: (value) => String(value || '').trim().toLowerCase(),
      sanitizeConnectionForLog: (connection, metadata = {}) => ({
        id: connection?.id || null,
        tenantSlug: connection?.tenantSlug || null,
        tenantId: connection?.tenantId || null,
        status: connection?.status || null,
        direction: connection?.direction || null,
        connectionType: connection?.connectionType || null,
        provider: connection?.provider || null,
        environment: connection?.environment || null,
        to: String(connection?.identifier || '').trim().toLowerCase() || null,
        projectId: connection?.projectId || null,
        targetProjectId: connection?.targetProjectId || connection?.projectId || null,
        active: connection?.active !== false,
        isActive: connection?.isActive !== false,
        inactiveByRuntimeRule: connection?.active === false,
        ...metadata,
      }),
    },
  };

  require.cache[projectsModulePath] = {
    id: projectsModulePath,
    filename: projectsModulePath,
    loaded: true,
    exports: {
      getProjectById: async () =>
        projectById || {
          id: 'core-project-clinica-devtec',
          slug: 'clinica-devtec',
          tenantSlug: 'clinica-devtec',
          active: true,
        },
    },
  };

  require.cache[projectOverrideModulePath] = {
    id: projectOverrideModulePath,
    filename: projectOverrideModulePath,
    loaded: true,
    exports: {
      buildProjectOverrideRoutingContext: ({ to, project, projectOverride }) => ({
        to,
        connection: null,
        project,
        projectOverride,
        tenantSlug: 'clinica-devtec',
        devMode: true,
        projectOverrideUsed: true,
        routingSource: 'session_override',
      }),
      clearSessionProjectOverride: () => null,
      getSessionProjectOverride: () => null,
      resolveProjectTenantSlug: () => 'clinica-devtec',
    },
  };

  require.cache[tenantModulePath] = {
    id: tenantModulePath,
    filename: tenantModulePath,
    loaded: true,
    exports: {
      ACTIVE_TENANT_SLUG: 'clinica-devtec',
      normalizeTenantSlug: (value) => String(value || '').trim().toLowerCase(),
    },
  };

  return require('../lib/routing/resolveProject');
}

test.afterEach(() => {
  restoreAllModules();
});

test('aplica fallback por tenant quando strict lookup retorna connection_not_found', async () => {
  const resolveProject = loadRoutingWithMocks({
    connectionsByIdentifier: [],
    connectionsByTenantSlug: [
      {
        id: 'conn-fallback',
        identifier: 'whatsapp:+14155238886',
        projectId: 'core-project-clinica-devtec',
        active: true,
      },
    ],
  });

  const context = await resolveProject.resolveProjectByIncomingNumber('whatsapp:+14155238886', {
    tenantSlug: 'clinica-devtec',
  });

  assert.equal(context.connection.id, 'conn-fallback');
  assert.equal(context.project.id, 'core-project-clinica-devtec');
  assert.equal(context.routingSource, 'tenant_fallback');
});

test('falha com erro explicito quando fallback por tenant encontra mais de uma conexao ativa', async () => {
  const resolveProject = loadRoutingWithMocks({
    connectionsByIdentifier: [],
    connectionsByTenantSlug: [
      {
        id: 'conn-a',
        identifier: 'whatsapp:+14155238886',
        projectId: 'core-project-clinica-devtec',
        active: true,
      },
      {
        id: 'conn-b',
        identifier: 'whatsapp:+14155238886',
        projectId: 'core-project-clinica-devtec',
        active: true,
      },
    ],
  });

  await assert.rejects(
    () =>
      resolveProject.resolveProjectByIncomingNumber('whatsapp:+14155238886', {
        tenantSlug: 'clinica-devtec',
      }),
    (error) => {
      assert.equal(error.code, 'fallback_connection_ambiguous');
      return true;
    },
  );
});
