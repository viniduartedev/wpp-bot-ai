const test = require('node:test');
const assert = require('node:assert/strict');

const webhookHandler = require('../api/webhook');
const { buildServiceRequestData } = require('../lib/core/serviceRequests');
const { loadProjectServices, loadRuntimeProjectServices } = require('../lib/bot/services');
const { buildSessionData } = require('../lib/core/sessions');
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
  const fakeAdmin = {
    firestore: {
      FieldValue: {
        serverTimestamp: () => 'server-timestamp',
      },
    },
  };
  const fakeBotDb = {
    batch: () => ({
      set: () => {},
      commit: async () => {},
    }),
    collection: () => ({
      doc: () => ({
        set: async () => {},
      }),
    }),
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
