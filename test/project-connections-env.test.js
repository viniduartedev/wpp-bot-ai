const test = require('node:test');
const assert = require('node:assert/strict');

const projectConnectionsModulePath = require.resolve('../lib/core/projectConnections');
const firebaseAdminModulePath = require.resolve('../lib/firebase-admin');
const coreConfigModulePath = require.resolve('../lib/core/config');

const originalProjectConnectionsModule = require.cache[projectConnectionsModulePath];
const originalFirebaseAdminModule = require.cache[firebaseAdminModulePath];
const originalCoreConfigModule = require.cache[coreConfigModulePath];
const originalBotRuntimeEnv = process.env.BOT_RUNTIME_ENV;

function restoreModule(modulePath, originalModule) {
  if (originalModule) {
    require.cache[modulePath] = originalModule;
    return;
  }

  delete require.cache[modulePath];
}

function buildFirestoreMock(initialCollections = {}) {
  const collections = new Map(
    Object.entries(initialCollections).map(([collectionName, docs]) => [
      collectionName,
      new Map(Object.entries(docs || {})),
    ]),
  );

  function ensureCollection(collectionName) {
    if (!collections.has(collectionName)) {
      collections.set(collectionName, new Map());
    }

    return collections.get(collectionName);
  }

  function matchesFilters(docData, filters) {
    return filters.every((filter) => docData?.[filter.field] === filter.value);
  }

  function buildQuery(collectionName, filters = []) {
    return {
      where(field, operator, value) {
        assert.equal(operator, '==');
        return buildQuery(collectionName, [...filters, { field, value }]);
      },
      async get() {
        const docs = Array.from(ensureCollection(collectionName).entries())
          .filter(([, docData]) => matchesFilters(docData, filters))
          .map(([docId, docData]) => ({
            id: docId,
            data: () => docData,
            get: (fieldName) => docData[fieldName],
          }));

        return {
          docs,
          empty: docs.length === 0,
          size: docs.length,
        };
      },
    };
  }

  return {
    collection(collectionName) {
      return {
        where(field, operator, value) {
          assert.equal(operator, '==');
          return buildQuery(collectionName, [{ field, value }]);
        },
      };
    },
  };
}

function loadProjectConnectionsModule({ botRuntimeEnv, collections }) {
  process.env.BOT_RUNTIME_ENV = botRuntimeEnv;
  delete require.cache[projectConnectionsModulePath];
  delete require.cache[coreConfigModulePath];

  require.cache[firebaseAdminModulePath] = {
    id: firebaseAdminModulePath,
    filename: firebaseAdminModulePath,
    loaded: true,
    exports: {
      getFirestoreClients: () => ({
        botDb: buildFirestoreMock(collections),
        firebaseProjectId: 'bot-whatsapp-ai-d10ef',
      }),
    },
  };

  return require('../lib/core/projectConnections');
}

test.afterEach(() => {
  restoreModule(projectConnectionsModulePath, originalProjectConnectionsModule);
  restoreModule(firebaseAdminModulePath, originalFirebaseAdminModule);
  restoreModule(coreConfigModulePath, originalCoreConfigModule);

  if (typeof originalBotRuntimeEnv === 'undefined') {
    delete process.env.BOT_RUNTIME_ENV;
  } else {
    process.env.BOT_RUNTIME_ENV = originalBotRuntimeEnv;
  }
});

test('usa diagnostico sem environment para tenant quando o filtro de ambiente nao encontra resultados', async () => {
  const projectConnections = loadProjectConnectionsModule({
    botRuntimeEnv: 'production',
    collections: {
      projectConnections: {
        'connection-dev': {
          tenantSlug: 'clinica-devtec',
          connectionType: 'whatsapp',
          provider: 'twilio',
          identifier: 'whatsapp:+14155238886',
          environment: 'dev',
          projectId: 'core-project-clinica-devtec',
          active: true,
        },
      },
    },
  });

  const connections = await projectConnections.findWhatsAppConnectionsByTenantSlug(
    'clinica-devtec',
  );

  assert.equal(connections.length, 1);
  assert.equal(connections[0].id, 'connection-dev');
  assert.equal(connections[0].environment, 'dev');
});

test('mantem resultado vazio quando nao existe conexao compativel nem ignorando environment', async () => {
  const projectConnections = loadProjectConnectionsModule({
    botRuntimeEnv: 'production',
    collections: {
      projectConnections: {
        'connection-other-provider': {
          tenantSlug: 'clinica-devtec',
          connectionType: 'whatsapp',
          provider: 'meta',
          identifier: 'whatsapp:+14155238886',
          environment: 'dev',
          projectId: 'core-project-clinica-devtec',
          active: true,
        },
      },
    },
  });

  const connections = await projectConnections.findWhatsAppConnectionsByTenantSlug(
    'clinica-devtec',
  );

  assert.equal(connections.length, 0);
});
