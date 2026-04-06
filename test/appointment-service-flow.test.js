const test = require('node:test');
const assert = require('node:assert/strict');

const webhookHandler = require('../api/webhook');
const { buildServiceRequestData } = require('../lib/core/serviceRequests');
const { loadProjectServices } = require('../lib/bot/services');

const {
  SESSION_STEPS,
  buildSessionContext,
  buildSessionKey,
  clearSessions,
  handleSchedulingFlow,
  sessions,
  startScheduling,
} = webhookHandler.__internals;

function buildRoutingContext(overrides = {}) {
  return {
    to: 'whatsapp:+5511999999999',
    project: {
      id: 'clinic-project',
      slug: 'clinica-aurora',
      name: 'Clínica Aurora',
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
      businessName: 'Clínica Aurora',
      assistantName: 'Clara',
      closingMessage: 'Nossa equipe vai confirmar os próximos passos em breve.',
      fallbackUsed: false,
      source: 'project',
    },
    routingSource: 'incoming_number',
    devMode: false,
    projectOverrideUsed: false,
    ...overrides,
  };
}

test.beforeEach(() => {
  clearSessions();
  delete process.env.BOT_PROJECT_SERVICES_JSON;
});

test.after(() => {
  clearSessions();
  delete process.env.BOT_PROJECT_SERVICES_JSON;
});

test('inicia agendamento pedindo a escolha do serviço', () => {
  const from = 'whatsapp:+5534999991111';
  const routingContext = buildRoutingContext();
  const sessionKey = buildSessionKey(from, routingContext.to);

  const response = startScheduling(
    sessionKey,
    buildSessionContext(from, routingContext),
    routingContext,
  );

  assert.match(response, /Qual serviço você deseja\?/);
  assert.match(response, /1 - Consulta/);
  assert.equal(sessions[sessionKey].step, SESSION_STEPS.AWAITING_SERVICE);
});

test('trata escolha inválida de serviço sem quebrar o fluxo', async () => {
  const from = 'whatsapp:+5534999991111';
  const routingContext = buildRoutingContext();
  const sessionKey = buildSessionKey(from, routingContext.to);

  startScheduling(sessionKey, buildSessionContext(from, routingContext), routingContext);

  const response = await handleSchedulingFlow(sessionKey, from, routingContext, '99');

  assert.match(response, /Não consegui identificar a opção escolhida/);
  assert.match(response, /1 - Consulta/);
  assert.equal(sessions[sessionKey].step, SESSION_STEPS.AWAITING_SERVICE);
});

test('inclui o serviço selecionado no resumo final do fluxo', async () => {
  const from = 'whatsapp:+5534999991111';
  const routingContext = buildRoutingContext();
  const sessionKey = buildSessionKey(from, routingContext.to);

  startScheduling(sessionKey, buildSessionContext(from, routingContext), routingContext);

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
      contactId: 'contact-1',
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
  assert.equal(serviceRequestData.requestedDate, '10/04');
  assert.equal(serviceRequestData.requestedTime, '14:00');
});

test('usa fallback configurável por projeto quando o Core não traz serviços', () => {
  process.env.BOT_PROJECT_SERVICES_JSON = JSON.stringify({
    'clinic-project': [
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
  assert.deepEqual(
    catalog.services.map((service) => service.label),
    ['Banho', 'Tosa'],
  );
});
