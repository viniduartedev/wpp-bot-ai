const test = require('node:test');
const assert = require('node:assert/strict');

const webhookHandler = require('../api/webhook');
const { buildServiceRequestData } = require('../lib/core/serviceRequests');
const { loadProjectServices, loadRuntimeProjectServices } = require('../lib/bot/services');
const { buildSessionData, buildSessionDocumentId } = require('../lib/core/sessions');
const { parseDevCommand, resolveProjectByDevInput } = require('../lib/dev/commands');
const { setSessionProjectOverride } = require('../lib/dev/projectOverride');

const {
  SESSION_STEPS,
  buildSessionContext,
  buildSessionKey,
  clearSessions,
  ensureSession,
  handleSchedulingFlow,
  resetSession,
  sessions,
  startScheduling,
} = webhookHandler.__internals;

const firebaseAdminModulePath = require.resolve('../lib/firebase-admin');
const originalFirebaseAdminModule = require.cache[firebaseAdminModulePath];

const DEFAULT_AGENDA_SERVICES = [
  {
    id: 'clinica-devtec-consulta',
    tenantSlug: 'clinica-devtec',
    key: 'consulta',
    label: 'Consulta',
    active: true,
    order: 1,
  },
  {
    id: 'clinica-devtec-retorno',
    tenantSlug: 'clinica-devtec',
    key: 'retorno',
    label: 'Retorno',
    active: true,
    order: 2,
  },
  {
    id: 'clinica-devtec-exame',
    tenantSlug: 'clinica-devtec',
    key: 'exame',
    label: 'Exame',
    active: true,
    order: 3,
  },
];

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createFirestoreStore(initialCollections = {}) {
  const collections = new Map();
  const counters = new Map();

  Object.entries(initialCollections).forEach(([collectionName, docs]) => {
    collections.set(
      collectionName,
      new Map(
        Object.entries(docs || {}).map(([docId, data]) => [docId, deepClone(data)]),
      ),
    );
  });

  function ensureCollection(collectionName) {
    if (!collections.has(collectionName)) {
      collections.set(collectionName, new Map());
    }

    return collections.get(collectionName);
  }

  function nextId(collectionName) {
    const nextValue = (counters.get(collectionName) || 0) + 1;
    counters.set(collectionName, nextValue);
    return `${collectionName}-${nextValue}`;
  }

  function mergeData(currentValue, nextValue) {
    return {
      ...(deepClone(currentValue) || {}),
      ...(deepClone(nextValue) || {}),
    };
  }

  function writeDoc(collectionName, docId, data, options = {}) {
    const collection = ensureCollection(collectionName);

    if (options.merge && collection.has(docId)) {
      collection.set(docId, mergeData(collection.get(docId), data));
      return;
    }

    collection.set(docId, deepClone(data));
  }

  function buildDocRef(collectionName, docId) {
    return {
      id: docId,
      _collectionName: collectionName,
      async set(data, options = {}) {
        writeDoc(collectionName, docId, data, options);
      },
      async get() {
        return buildDocSnapshot(collectionName, docId);
      },
    };
  }

  function buildDocSnapshot(collectionName, docId) {
    const collection = ensureCollection(collectionName);
    const data = collection.get(docId);

    return {
      id: docId,
      exists: typeof data !== 'undefined',
      data: () => deepClone(data),
      get: (fieldName) => data?.[fieldName],
      ref: buildDocRef(collectionName, docId),
    };
  }

  function matchesFilter(docData, filter) {
    if (filter.operator !== '==') {
      throw new Error(`Unsupported operator in test mock: ${filter.operator}`);
    }

    return docData?.[filter.field] === filter.value;
  }

  function buildQuery(collectionName, filters = [], limitValue = null) {
    return {
      where(field, operator, value) {
        return buildQuery(
          collectionName,
          [...filters, { field, operator, value }],
          limitValue,
        );
      },
      limit(nextLimit) {
        return buildQuery(collectionName, filters, nextLimit);
      },
      async get() {
        let docs = Array.from(ensureCollection(collectionName).entries())
          .filter(([, docData]) => filters.every((filter) => matchesFilter(docData, filter)))
          .map(([docId]) => buildDocSnapshot(collectionName, docId));

        if (typeof limitValue === 'number') {
          docs = docs.slice(0, limitValue);
        }

        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
        };
      },
    };
  }

  return {
    collection(collectionName) {
      return {
        doc(docId) {
          return buildDocRef(collectionName, docId || nextId(collectionName));
        },
        async add(data) {
          const docRef = buildDocRef(collectionName, nextId(collectionName));
          await docRef.set(data);
          return docRef;
        },
        where(field, operator, value) {
          return buildQuery(collectionName, [{ field, operator, value }]);
        },
      };
    },
    batch() {
      const operations = [];

      return {
        set(docRef, data, options = {}) {
          operations.push({ docRef, data, options });
        },
        async commit() {
          operations.forEach(({ docRef, data, options }) => {
            writeDoc(docRef._collectionName, docRef.id, data, options);
          });
        },
      };
    },
    list(collectionName) {
      return Array.from(ensureCollection(collectionName).entries()).map(([id, data]) => ({
        id,
        ...deepClone(data),
      }));
    },
    get(collectionName, docId) {
      const collection = ensureCollection(collectionName);
      const data = collection.get(docId);

      if (typeof data === 'undefined') {
        return null;
      }

      return {
        id: docId,
        ...deepClone(data),
      };
    },
  };
}

function restoreFirebaseAdminModule() {
  if (originalFirebaseAdminModule) {
    require.cache[firebaseAdminModulePath] = originalFirebaseAdminModule;
  } else {
    delete require.cache[firebaseAdminModulePath];
  }
}

function setFirebaseAdminMock(options = {}) {
  const agendaServices = options.agendaServices ?? DEFAULT_AGENDA_SERVICES;
  const queriedFilters = options.queriedFilters || [];
  const agendaProjectId = options.agendaProjectId || 'agendamento-ai-9fbfb';
  const firestoreStore =
    options.firestoreStore || createFirestoreStore(options.initialBotCollections);
  const fakeAdmin = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'server-timestamp',
      },
    },
  };
  const fakeBotDb = {
    batch: () => firestoreStore.batch(),
    collection: (collectionName) => firestoreStore.collection(collectionName),
  };

  require.cache[firebaseAdminModulePath] = {
    id: firebaseAdminModulePath,
    filename: firebaseAdminModulePath,
    loaded: true,
    exports: {
      EXPECTED_AGENDA_FIREBASE_PROJECT_ID: 'agendamento-ai-9fbfb',
      EXPECTED_BOT_FIREBASE_PROJECT_ID: 'bot-whatsapp-ai-d10ef',
      getFirestoreClients: () => ({
        admin: fakeAdmin,
        botDb: fakeBotDb,
        firebaseProjectId: 'bot-whatsapp-ai-d10ef',
      }),
      getAgendaFirestoreClient: () => ({
        admin: fakeAdmin,
        agendaDb: {
          collection: (collectionName) => {
            if (options.onAgendaCollection) {
              options.onAgendaCollection(collectionName);
            }

            return {
              where: (field, operator, value) => {
                queriedFilters.push({ field, operator, value });

                return {
                  get: async () => ({
                    docs: agendaServices.map((service) => ({
                      id: service.id,
                      data: () => service,
                    })),
                  }),
                };
              },
            };
          },
        },
        agendaFirebaseProjectId: agendaProjectId,
        firebaseProjectId: agendaProjectId,
      }),
    },
  };

  return {
    firestoreStore,
    queriedFilters,
  };
}

function buildRoutingContext(overrides = {}) {
  return {
    to: 'whatsapp:+5511999999999',
    project: {
      id: 'clinic-project',
      slug: 'clinica-devtec',
      name: 'Clínica Devtec',
      services: [
        { key: 'consulta', label: 'Consulta' },
        { key: 'retorno', label: 'Retorno' },
        { key: 'exame', label: 'Exame' },
      ],
    },
    connection: {
      id: 'connection-1',
      identifier: 'whatsapp:+5511999999999',
    },
    botProfile: {
      businessName: 'Clínica Devtec',
      assistantName: 'Clara',
      closingMessage: 'Nossa equipe vai confirmar os próximos passos em breve.',
      fallbackUsed: false,
      source: 'project',
    },
    tenantSlug: 'clinica-devtec',
    routingSource: 'incoming_number',
    devMode: false,
    projectOverrideUsed: false,
    ...overrides,
  };
}

function createResponseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function invokeWebhook({
  from = 'whatsapp:+5534999991111',
  to = 'whatsapp:+5511999999999',
  body,
}) {
  const req = {
    method: 'POST',
    body: {
      From: from,
      To: to,
      Body: body,
    },
  };
  const res = createResponseMock();

  await webhookHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/xml');

  return res;
}

test.beforeEach(() => {
  clearSessions();
  delete process.env.BOT_PROJECT_SERVICES_JSON;
  setFirebaseAdminMock();
});

test.after(() => {
  clearSessions();
  delete process.env.BOT_PROJECT_SERVICES_JSON;
  restoreFirebaseAdminModule();
});

test('inicia agendamento pedindo a escolha do serviço', async () => {
  const from = 'whatsapp:+5534999991111';
  const routingContext = buildRoutingContext();
  const sessionKey = buildSessionKey(from, routingContext.to);

  const response = await startScheduling(
    sessionKey,
    buildSessionContext(from, routingContext),
    routingContext,
  );

  assert.match(response, /Qual serviço você deseja\?/);
  assert.match(response, /1 - Consulta/);
  assert.equal(sessions[sessionKey].step, SESSION_STEPS.AWAITING_SERVICE);
  assert.equal(sessions[sessionKey].tenantSlug, 'clinica-devtec');
});

test('trata escolha inválida de serviço sem quebrar o fluxo', async () => {
  const from = 'whatsapp:+5534999991111';
  const routingContext = buildRoutingContext();
  const sessionKey = buildSessionKey(from, routingContext.to);

  await startScheduling(sessionKey, buildSessionContext(from, routingContext), routingContext);

  const response = await handleSchedulingFlow(sessionKey, from, routingContext, '99');

  assert.match(response, /Não consegui identificar a opção escolhida/);
  assert.match(response, /1 - Consulta/);
  assert.equal(sessions[sessionKey].step, SESSION_STEPS.AWAITING_SERVICE);
});

test('exige número da opção ao selecionar serviço pelo WhatsApp', async () => {
  const from = 'whatsapp:+5534999991111';
  const routingContext = buildRoutingContext();
  const sessionKey = buildSessionKey(from, routingContext.to);

  await startScheduling(sessionKey, buildSessionContext(from, routingContext), routingContext);

  const response = await handleSchedulingFlow(sessionKey, from, routingContext, 'Consulta');

  assert.match(response, /Não consegui identificar a opção escolhida/);
  assert.equal(sessions[sessionKey].step, SESSION_STEPS.AWAITING_SERVICE);
  assert.equal(sessions[sessionKey].data.selectedServiceKey, '');
  assert.equal(sessions[sessionKey].data.selectedServiceLabel, '');
});

test('normaliza o tenant informado no comando /dev', () => {
  const parsedCommand = parseDevCommand('  /DEV   Clinica-Devtec  ');

  assert.equal(parsedCommand?.type, 'set_project');
  assert.equal(parsedCommand?.normalizedInput, 'clinica-devtec');
});

test('bloqueia outros slugs no /dev temporario', async () => {
  const resolution = await resolveProjectByDevInput('barbearia-premium');

  assert.equal(resolution, null);
});

test('preserva tenantSlug na sessão ao aplicar override via /dev', () => {
  const from = 'whatsapp:+5534999991111';
  const to = 'whatsapp:+5511999999999';
  const sessionKey = buildSessionKey(from, to);
  const session = ensureSession(sessionKey, { from, to });

  setSessionProjectOverride(session, {
    id: 'clinic-project',
    slug: 'clinica-devtec',
    name: 'Clínica Devtec',
  });

  resetSession(
    sessionKey,
    {
      from,
      to,
      projectId: 'clinic-project',
      tenantSlug: 'clinica-devtec',
      devMode: true,
      projectOverrideUsed: true,
      routingSource: 'session_override',
    },
    { preserveProjectOverride: true },
  );

  assert.equal(sessions[sessionKey].tenantSlug, 'clinica-devtec');
  assert.equal(sessions[sessionKey].projectOverride?.tenantSlug, 'clinica-devtec');
});

test('inclui o serviço selecionado no resumo final do fluxo', async () => {
  const from = 'whatsapp:+5534999991111';
  const routingContext = buildRoutingContext();
  const sessionKey = buildSessionKey(from, routingContext.to);

  await startScheduling(sessionKey, buildSessionContext(from, routingContext), routingContext);

  const serviceResponse = await handleSchedulingFlow(sessionKey, from, routingContext, '1');
  assert.match(serviceResponse, /Perfeito, você escolheu: Consulta/);
  assert.equal(sessions[sessionKey].data.selectedServiceKey, 'consulta');
  assert.equal(sessions[sessionKey].data.selectedServiceLabel, 'Consulta');

  await handleSchedulingFlow(sessionKey, from, routingContext, 'João Silva');
  await handleSchedulingFlow(sessionKey, from, routingContext, '10/04');
  const confirmationResponse = await handleSchedulingFlow(
    sessionKey,
    from,
    routingContext,
    '14:00',
  );

  assert.match(confirmationResponse, /Serviço: Consulta/);
  assert.match(confirmationResponse, /Nome: João Silva/);
  assert.match(confirmationResponse, /Data: 10\/04/);
  assert.match(confirmationResponse, /Horário: 14:00/);
  assert.equal(sessions[sessionKey].step, SESSION_STEPS.AWAITING_CONFIRMATION);
});

test('continua o fluxo ao receber o nome mesmo sem ProjectConnection no meio da conversa', async () => {
  const from = 'whatsapp:+5534999991111';
  const to = 'whatsapp:+14155238886';
  const { firestoreStore } = setFirebaseAdminMock({
    initialBotCollections: {
      projectConnections: {
        'connection-1': {
          connectionType: 'whatsapp',
          provider: 'twilio',
          identifier: to,
          projectId: 'clinic-project',
          tenantSlug: 'clinica-devtec',
          active: true,
        },
      },
      projects: {
        'clinic-project': {
          slug: 'clinica-devtec',
          name: 'Clínica Devtec',
          active: true,
        },
      },
      botProfiles: {
        'clinic-project': {
          projectId: 'clinic-project',
          assistantName: 'Clara',
          businessName: 'Clínica Devtec',
          closingMessage: 'Nossa equipe vai confirmar os próximos passos em breve.',
          active: true,
        },
      },
    },
  });

  await invokeWebhook({ from, to, body: 'oi' });
  await invokeWebhook({ from, to, body: '1' });
  const serviceResponse = await invokeWebhook({ from, to, body: '1' });

  assert.match(serviceResponse.body, /nome completo/i);

  await firestoreStore.collection('projectConnections').doc('connection-1').set({
    connectionType: 'whatsapp',
    provider: 'twilio',
    identifier: 'whatsapp:+00000000000',
    projectId: 'clinic-project',
    tenantSlug: 'clinica-devtec',
    active: false,
  });

  clearSessions();

  const nameResponse = await invokeWebhook({ from, to, body: 'Maria da Silva' });
  const sessionId = buildSessionDocumentId(buildSessionKey(from, to));
  const sessionDoc = firestoreStore.get('sessions', sessionId);
  const inboundEvents = firestoreStore.list('inboundEvents');

  assert.match(nameResponse.body, /qual data/i);
  assert.ok(sessionDoc);
  assert.equal(sessionDoc.currentStep, SESSION_STEPS.AWAITING_DATE);
  assert.equal(sessionDoc.data.name, 'Maria da Silva');
  assert.equal(sessionDoc.projectId, 'clinic-project');
  assert.equal(sessionDoc.selectedServiceKey, 'consulta');
  assert.equal(
    inboundEvents.some((event) => event.eventType === 'channel_routing_failed'),
    false,
  );
});

test('escolher serviço no webhook sempre devolve o prompt de nome e persiste a sessão', async () => {
  const from = 'whatsapp:+5534999991111';
  const to = 'whatsapp:+14155238886';
  const { firestoreStore } = setFirebaseAdminMock({
    initialBotCollections: {
      projectConnections: {
        'connection-1': {
          connectionType: 'whatsapp',
          provider: 'twilio',
          identifier: to,
          projectId: 'clinic-project',
          tenantSlug: 'clinica-devtec',
          active: true,
        },
      },
      projects: {
        'clinic-project': {
          slug: 'clinica-devtec',
          name: 'Clínica Devtec',
          active: true,
        },
      },
      botProfiles: {
        'clinic-project': {
          projectId: 'clinic-project',
          assistantName: 'Clara',
          businessName: 'Clínica Devtec',
          closingMessage: 'Nossa equipe vai confirmar os próximos passos em breve.',
          active: true,
        },
      },
    },
  });

  await invokeWebhook({ from, to, body: 'oi' });
  await invokeWebhook({ from, to, body: '1' });
  const serviceResponse = await invokeWebhook({ from, to, body: '1' });

  const sessionId = buildSessionDocumentId(buildSessionKey(from, to));
  const sessionDoc = firestoreStore.get('sessions', sessionId);

  assert.match(serviceResponse.body, /Agora me informe o seu nome completo/i);
  assert.ok(serviceResponse.body.trim().length > 0);
  assert.ok(sessionDoc);
  assert.equal(sessionDoc.currentStep, SESSION_STEPS.AWAITING_NAME);
  assert.equal(sessionDoc.selectedServiceKey, 'consulta');
  assert.equal(sessionDoc.selectedServiceLabel, 'Consulta');
});

test('dev reset continua respondendo mesmo após a seleção do serviço', async () => {
  const from = 'whatsapp:+5534999991111';
  const to = 'whatsapp:+14155238886';

  setFirebaseAdminMock({
    initialBotCollections: {
      projectConnections: {
        'connection-1': {
          connectionType: 'whatsapp',
          provider: 'twilio',
          identifier: to,
          projectId: 'clinic-project',
          tenantSlug: 'clinica-devtec',
          active: true,
        },
      },
      projects: {
        'clinic-project': {
          slug: 'clinica-devtec',
          name: 'Clínica Devtec',
          active: true,
        },
      },
      botProfiles: {
        'clinic-project': {
          projectId: 'clinic-project',
          assistantName: 'Clara',
          businessName: 'Clínica Devtec',
          closingMessage: 'Nossa equipe vai confirmar os próximos passos em breve.',
          active: true,
        },
      },
    },
  });

  await invokeWebhook({ from, to, body: 'oi' });
  await invokeWebhook({ from, to, body: '1' });
  await invokeWebhook({ from, to, body: '1' });
  const resetResponse = await invokeWebhook({ from, to, body: '/dev reset' });

  assert.ok(resetResponse.body.trim().length > 0);
  assert.match(resetResponse.body, /<Message>/i);
});

test('inclui o serviço no payload persistido da serviceRequest', () => {
  const serviceRequestData = buildServiceRequestData(
    {
      projectId: 'clinic-project',
      tenantSlug: 'BARBEARIA-PREMIUM',
      contactId: 'contact-1',
      sessionId: 'session-1',
      requestedDate: '10/04',
      requestedTime: '14:00',
      service: {
        key: 'consulta',
        label: 'Consulta',
      },
    },
    {
      createdAt: 'server-timestamp',
    },
  );

  assert.deepEqual(serviceRequestData.service, {
    key: 'consulta',
    label: 'Consulta',
  });
  assert.equal(serviceRequestData.sessionId, 'session-1');
  assert.equal(serviceRequestData.tenantSlug, 'clinica-devtec');
  assert.equal(serviceRequestData.requestedDate, '10/04');
  assert.equal(serviceRequestData.requestedTime, '14:00');
});

test('usa fallback configuravel do tenant ativo quando o Core nao traz servicos', () => {
  process.env.BOT_PROJECT_SERVICES_JSON = JSON.stringify({
    'clinica-devtec': [
      { key: 'banho', label: 'Banho' },
      { key: 'tosa', label: 'Tosa' },
    ],
  });

  const catalog = loadProjectServices({
    id: 'clinic-project',
    slug: 'petshop-demo',
    name: 'Petshop Demo',
  });

  assert.equal(catalog.source, 'bot_fallback_env');
  assert.equal(catalog.usedFallback, true);
  assert.equal(catalog.resolvedFrom, 'clinica-devtec');
  assert.deepEqual(
    catalog.services.map((service) => service.label),
    ['Banho', 'Tosa'],
  );
});

test('mantem fallback preso ao tenant ativo mesmo se outro tenant for informado', () => {
  process.env.BOT_PROJECT_SERVICES_JSON = JSON.stringify({
    'petshop-demo': [
      { key: 'banho', label: 'Banho' },
      { key: 'tosa', label: 'Tosa' },
    ],
    'clinica-devtec': [
      { key: 'consulta', label: 'Consulta' },
      { key: 'retorno', label: 'Retorno' },
      { key: 'exame', label: 'Exame' },
    ],
  });

  const catalog = loadProjectServices(
    {
      id: 'clinic-project',
      slug: 'petshop-demo',
      name: 'Projeto com fallback compartilhado',
    },
    {
      tenantSlug: 'petshop-demo',
    },
  );

  assert.equal(catalog.source, 'bot_fallback_env');
  assert.equal(catalog.usedFallback, true);
  assert.equal(catalog.resolvedFrom, 'clinica-devtec');
  assert.deepEqual(
    catalog.services.map((service) => service.key),
    ['consulta', 'retorno', 'exame'],
  );
});

test('carrega serviços reais do tenant pelo agendaDb operacional', async () => {
  const queriedFilters = [];
  const fakeServices = [
    {
      id: 'clinica-devtec-retorno',
      projectId: 'core-project-clinica-devtec',
      tenantSlug: 'clinica-devtec',
      key: 'retorno',
      label: 'Retorno',
      active: true,
      sortOrder: '2',
    },
    {
      id: 'clinica-devtec-consulta-avaliacao',
      projectId: 'core-project-clinica-devtec',
      tenantSlug: 'clinica-devtec',
      key: 'consulta_avaliacao',
      label: 'Consulta de avaliação',
      active: true,
      order: 1,
    },
    {
      id: 'clinica-devtec-inativo',
      projectId: 'core-project-clinica-devtec',
      tenantSlug: 'clinica-devtec',
      key: 'inativo',
      label: 'Inativo',
      active: false,
      order: 3,
    },
    {
      id: 'clinica-devtec-procedimento',
      projectId: 'core-project-clinica-devtec',
      tenantSlug: 'clinica-devtec',
      key: 'procedimento',
      label: 'Procedimento',
      active: true,
      displayOrder: 3,
    },
    {
      id: 'barbearia-premium-corte',
      projectId: 'core-project-barbearia-premium',
      tenantSlug: 'barbearia-premium',
      key: 'corte',
      label: 'Corte',
      active: true,
      order: 1,
    },
  ];

  setFirebaseAdminMock({
    agendaServices: fakeServices,
    queriedFilters,
    onAgendaCollection: (collectionName) => {
      assert.equal(collectionName, 'services');
    },
  });

  const catalog = await loadRuntimeProjectServices(
    {
      id: 'core-project-clinica-devtec',
      slug: 'clinica-devtec',
    },
    {
      tenantSlug: 'clinica-devtec',
    },
  );

  assert.equal(catalog.source, 'agenda_firestore_services');
  assert.equal(catalog.servicesSource, 'agendamento-ai-9fbfb');
  assert.equal(catalog.firebaseProjectId, 'agendamento-ai-9fbfb');
  assert.deepEqual(queriedFilters, [
    { field: 'tenantSlug', operator: '==', value: 'clinica-devtec' },
  ]);
  assert.deepEqual(
    catalog.services.map((service) => service.key),
    ['consulta_avaliacao', 'retorno', 'procedimento'],
  );
});

test('nao aplica fallback quando a agenda responde sem servicos ativos para o tenant', async () => {
  process.env.BOT_PROJECT_SERVICES_JSON = JSON.stringify({
    'clinica-devtec': [{ key: 'consulta', label: 'Consulta' }],
  });

  setFirebaseAdminMock({
    agendaServices: [],
    onAgendaCollection: (collectionName) => {
      assert.equal(collectionName, 'services');
    },
  });

  const catalog = await loadRuntimeProjectServices({
    id: 'core-project-clinica-devtec',
    slug: 'clinica-devtec',
  });

  assert.equal(catalog.source, 'agenda_firestore_services');
  assert.equal(catalog.tenantSlug, 'clinica-devtec');
  assert.equal(catalog.usedFallback, false);
  assert.deepEqual(catalog.services, []);
});

test('monta payload de sessão com tenant e serviço selecionado para o botDb', () => {
  const sessionData = buildSessionData({
    sessionKey: 'whatsapp:+5534999991111::whatsapp:+5511999999999',
    status: 'active',
    lastInboundText: '1',
    session: {
      step: SESSION_STEPS.AWAITING_NAME,
      tenantSlug: 'barbearia-premium',
      data: {
        selectedServiceKey: 'consulta_avaliacao',
        selectedServiceLabel: 'Consulta de avaliação',
      },
      context: {
        from: 'whatsapp:+5534999991111',
        to: 'whatsapp:+5511999999999',
        projectId: 'core-project-clinica-devtec',
        tenantSlug: 'barbearia-premium',
        devMode: true,
        projectOverrideUsed: true,
      },
    },
  });

  assert.equal(sessionData.projectId, 'core-project-clinica-devtec');
  assert.equal(sessionData.tenantSlug, 'clinica-devtec');
  assert.equal(sessionData.currentStep, SESSION_STEPS.AWAITING_NAME);
  assert.equal(sessionData.selectedServiceKey, 'consulta_avaliacao');
  assert.equal(sessionData.selectedServiceLabel, 'Consulta de avaliação');
  assert.equal(sessionData.lastInboundText, '1');
});

test('rehidrata a sessão do Firestore e persiste inboundEvents, session e serviceRequest no fluxo real', async () => {
  const from = 'whatsapp:+5534999991111';
  const to = 'whatsapp:+5511999999999';
  const { firestoreStore } = setFirebaseAdminMock({
    initialBotCollections: {
      projectConnections: {
        'connection-1': {
          connectionType: 'whatsapp',
          provider: 'twilio',
          identifier: to,
          projectId: 'clinic-project',
          tenantSlug: 'clinica-devtec',
          active: true,
        },
      },
      projects: {
        'clinic-project': {
          slug: 'clinica-devtec',
          name: 'Clínica Devtec',
          active: true,
        },
      },
      botProfiles: {
        'clinic-project': {
          projectId: 'clinic-project',
          assistantName: 'Clara',
          businessName: 'Clínica Devtec',
          closingMessage: 'Nossa equipe vai confirmar os próximos passos em breve.',
          active: true,
        },
      },
    },
  });

  for (const message of ['oi', '1', '1', 'Maria da Silva', '15/04', '14:00', '1']) {
    await invokeWebhook({ from, to, body: message });
    clearSessions();
  }

  const sessionId = buildSessionDocumentId(buildSessionKey(from, to));
  const sessionDoc = firestoreStore.get('sessions', sessionId);
  const inboundEvents = firestoreStore.list('inboundEvents');
  const contacts = firestoreStore.list('contacts');
  const serviceRequests = firestoreStore.list('serviceRequests');

  assert.ok(sessionDoc);
  assert.equal(sessionDoc.currentStep, SESSION_STEPS.MENU);
  assert.equal(sessionDoc.status, 'completed');
  assert.ok(
    inboundEvents.some((event) => event.eventType === 'message_received' && event.status === 'received'),
  );
  assert.ok(
    inboundEvents.some(
      (event) =>
        event.eventType === 'service_request_created' && event.status === 'processed',
    ),
  );
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].phone, from);
  assert.equal(contacts[0].projectId, 'clinic-project');
  assert.equal(contacts[0].name, 'Maria da Silva');
  assert.equal(serviceRequests.length, 1);
  assert.equal(serviceRequests[0].contactId, contacts[0].id);
  assert.deepEqual(serviceRequests[0].service, {
    key: 'consulta',
    label: 'Consulta',
  });
});

test('reidrata sessão parcial e refaz o routing por incoming_number para preencher connectionId e botProfileId', async () => {
  const from = 'whatsapp:+553496794527';
  const to = 'whatsapp:+14155238886';
  const sessionKey = buildSessionKey(from, to);
  const sessionId = buildSessionDocumentId(sessionKey);
  const { firestoreStore } = setFirebaseAdminMock({
    initialBotCollections: {
      projectConnections: {
        'connection-1': {
          connectionType: 'whatsapp',
          provider: 'twilio',
          identifier: to,
          projectId: 'core-project-clinica-devtec',
          tenantSlug: 'clinica-devtec',
          environment: 'dev',
          active: true,
        },
      },
      projects: {
        'core-project-clinica-devtec': {
          slug: 'clinica-devtec',
          tenantSlug: 'clinica-devtec',
          name: 'Clínica Devtec',
          active: true,
        },
      },
      botProfiles: {
        'core-project-clinica-devtec': {
          projectId: 'core-project-clinica-devtec',
          tenantSlug: 'clinica-devtec',
          assistantName: 'Clara',
          businessName: 'Clínica Devtec',
          tone: 'professional',
          menuOptions: [
            {
              key: 'schedule',
              label: 'Agendar atendimento',
              enabled: true,
            },
            {
              key: 'hours',
              label: 'Horário de atendimento',
              enabled: true,
            },
            {
              key: 'address',
              label: 'Endereço',
              enabled: true,
            },
            {
              key: 'human',
              label: 'Falar com a equipe',
              enabled: true,
            },
          ],
          closingMessage: 'Nossa equipe vai confirmar os próximos passos em breve.',
          welcomeMessage:
            'Olá! Aqui é a Clara, assistente virtual da Clínica Devtec. Posso te ajudar.',
          active: true,
        },
      },
      sessions: {
        [sessionId]: {
          sessionKey,
          projectId: 'core-project-clinica-devtec',
          tenantSlug: 'clinica-devtec',
          channel: 'whatsapp',
          phone: from,
          to,
          status: 'active',
          currentStep: SESSION_STEPS.MENU,
          data: {
            selectedServiceKey: '',
            selectedServiceLabel: '',
            name: '',
            date: '',
            time: '',
          },
          context: {
            from,
            to,
            projectId: 'core-project-clinica-devtec',
            tenantSlug: 'clinica-devtec',
            connectionId: null,
            connectionIdentifier: null,
            botProfileId: null,
            botProfileFallbackUsed: false,
            botProfileSource: null,
            routingSource: 'incoming_number',
            devMode: false,
            projectOverrideUsed: false,
          },
        },
      },
    },
  });

  const response = await invokeWebhook({ from, to, body: 'oi' });
  const sessionDoc = firestoreStore.get('sessions', sessionId);

  assert.match(response.body, /Clara|assistente virtual/i);
  assert.ok(sessionDoc);
  assert.equal(sessionDoc.projectId, 'core-project-clinica-devtec');
  assert.equal(sessionDoc.context.projectId, 'core-project-clinica-devtec');
  assert.equal(sessionDoc.context.connectionId, 'connection-1');
  assert.equal(sessionDoc.context.connectionIdentifier, 'whatsapp:+14155238886');
  assert.equal(sessionDoc.context.botProfileId, 'core-project-clinica-devtec');
  assert.equal(sessionDoc.context.botProfileSource, 'project');
  assert.equal(sessionDoc.context.botProfileFallbackUsed, false);
  assert.equal(sessionDoc.context.routingSource, 'incoming_number');
  assert.equal(sessions[sessionKey].context.projectId, 'core-project-clinica-devtec');
  assert.equal(sessions[sessionKey].context.connectionId, 'connection-1');
  assert.equal(sessions[sessionKey].context.botProfileId, 'core-project-clinica-devtec');
  assert.equal(sessions[sessionKey].context.botProfile?.id, 'core-project-clinica-devtec');
});

test('permite que o mesmo número abra mais de uma serviceRequest em momentos diferentes', async () => {
  const from = 'whatsapp:+5534999991111';
  const to = 'whatsapp:+5511999999999';
  const { firestoreStore } = setFirebaseAdminMock({
    initialBotCollections: {
      projectConnections: {
        'connection-1': {
          connectionType: 'whatsapp',
          provider: 'twilio',
          identifier: to,
          projectId: 'clinic-project',
          tenantSlug: 'clinica-devtec',
          active: true,
        },
      },
      projects: {
        'clinic-project': {
          slug: 'clinica-devtec',
          name: 'Clínica Devtec',
          active: true,
        },
      },
      botProfiles: {
        'clinic-project': {
          projectId: 'clinic-project',
          assistantName: 'Clara',
          businessName: 'Clínica Devtec',
          closingMessage: 'Nossa equipe vai confirmar os próximos passos em breve.',
          active: true,
        },
      },
    },
  });

  const messageFlows = [
    ['oi', '1', '1', 'Maria da Silva', '15/04', '14:00', '1'],
    ['oi', '1', '2', 'João Pereira', '16/04', '15:00', '1'],
  ];

  for (const messages of messageFlows) {
    for (const message of messages) {
      await invokeWebhook({ from, to, body: message });
      clearSessions();
    }
  }

  const contacts = firestoreStore.list('contacts');
  const serviceRequests = firestoreStore.list('serviceRequests');

  assert.equal(contacts.length, 1);
  assert.equal(serviceRequests.length, 2);
  assert.deepEqual(
    serviceRequests.map((serviceRequest) => serviceRequest.contactId),
    [contacts[0].id, contacts[0].id],
  );
  assert.deepEqual(
    serviceRequests.map((serviceRequest) => serviceRequest.requestedDate),
    ['15/04', '16/04'],
  );
  assert.deepEqual(
    serviceRequests.map((serviceRequest) => serviceRequest.service?.key),
    ['consulta', 'retorno'],
  );
});
