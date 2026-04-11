const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  firebaseProjectId: 'bot-whatsapp-ai-d10ef',
  tenantSlug: 'clinica-devtec',
  tenantId: 'demo-tenant',
  projectId: 'core-project-clinica-devtec',
  to: 'whatsapp:+14155238886',
  environment: process.env.BOT_RUNTIME_ENV?.trim() || 'dev',
  docId: 'project-connection-clinica-devtec-whatsapp-dev',
  collectionName: 'projectConnections',
};

function parseArgs(argv) {
  const options = {
    ...DEFAULTS,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const currentArg = argv[index];
    const nextArg = argv[index + 1];

    if (currentArg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (currentArg === '--project' && nextArg) {
      options.firebaseProjectId = nextArg;
      index += 1;
      continue;
    }

    if (currentArg === '--tenant-slug' && nextArg) {
      options.tenantSlug = nextArg;
      index += 1;
      continue;
    }

    if (currentArg === '--tenant-id' && nextArg) {
      options.tenantId = nextArg;
      index += 1;
      continue;
    }

    if (currentArg === '--project-id' && nextArg) {
      options.projectId = nextArg;
      index += 1;
      continue;
    }

    if (currentArg === '--to' && nextArg) {
      options.to = nextArg;
      index += 1;
      continue;
    }

    if (currentArg === '--environment' && nextArg) {
      options.environment = nextArg;
      index += 1;
      continue;
    }

    if (currentArg === '--doc-id' && nextArg) {
      options.docId = nextArg;
      index += 1;
    }
  }

  return options;
}

function normalizeConnectionIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function getFirebaseToolsConfig() {
  const configPath = path.join(process.env.HOME || '', '.config', 'configstore', 'firebase-tools.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Firebase CLI config não encontrado em ${configPath}. Rode "firebase login" antes.`);
  }

  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function getAccessToken() {
  const config = getFirebaseToolsConfig();
  const accessToken = config.tokens?.access_token;

  if (!accessToken) {
    throw new Error('Access token não encontrado no firebase-tools.json. Rode "firebase projects:list" para renovar o login.');
  }

  return accessToken;
}

function buildFirestoreValue(value) {
  if (value === null || typeof value === 'undefined') {
    return { nullValue: null };
  }

  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((item) => buildFirestoreValue(item)),
      },
    };
  }

  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }

  if (typeof value === 'number' && Number.isInteger(value)) {
    return { integerValue: String(value) };
  }

  if (typeof value === 'number') {
    return { doubleValue: value };
  }

  if (typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, buildFirestoreValue(item)]),
        ),
      },
    };
  }

  return { stringValue: String(value) };
}

function decodeFirestoreValue(value) {
  if (Object.hasOwn(value, 'stringValue')) {
    return value.stringValue;
  }

  if (Object.hasOwn(value, 'booleanValue')) {
    return value.booleanValue;
  }

  if (Object.hasOwn(value, 'integerValue')) {
    return Number(value.integerValue);
  }

  if (Object.hasOwn(value, 'doubleValue')) {
    return value.doubleValue;
  }

  if (Object.hasOwn(value, 'nullValue')) {
    return null;
  }

  if (Object.hasOwn(value, 'arrayValue')) {
    return (value.arrayValue.values || []).map((item) => decodeFirestoreValue(item));
  }

  if (Object.hasOwn(value, 'mapValue')) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decodeFirestoreValue(item)]),
    );
  }

  return null;
}

function decodeDocument(document) {
  return {
    name: document.name,
    createTime: document.createTime,
    updateTime: document.updateTime,
    fields: Object.fromEntries(
      Object.entries(document.fields || {}).map(([key, value]) => [key, decodeFirestoreValue(value)]),
    ),
  };
}

async function firestoreRequest(url, options = {}) {
  const accessToken = getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const error = new Error(`Firestore request failed with status ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function listProjectConnections(firebaseProjectId, collectionName) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents/${collectionName}?pageSize=100`;
  const body = await firestoreRequest(url);
  return (body.documents || []).map((document) => decodeDocument(document));
}

function buildChannelConnectionDocument(options, existingDocument = null) {
  const now = new Date().toISOString();

  return {
    tenantSlug: options.tenantSlug,
    tenantId: options.tenantId,
    projectId: options.projectId,
    connectionType: 'whatsapp',
    provider: 'twilio',
    status: 'active',
    active: true,
    isActive: true,
    direction: 'inbound',
    identifier: normalizeConnectionIdentifier(options.to),
    to: normalizeConnectionIdentifier(options.to),
    environment: options.environment,
    acceptedEventTypes: ['message'],
    createdAt: existingDocument?.fields?.createdAt || now,
    updatedAt: now,
  };
}

async function upsertDocument(firebaseProjectId, collectionName, docId, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents/${collectionName}/${docId}`;
  const body = {
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, buildFirestoreValue(value)]),
    ),
  };

  return decodeDocument(
    await firestoreRequest(url, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  );
}

function summarizeConnection(connection) {
  return {
    docPath: connection.name,
    projectId: connection.fields.projectId || null,
    targetProjectId: connection.fields.targetProjectId || null,
    tenantSlug: connection.fields.tenantSlug || null,
    tenantId: connection.fields.tenantId || null,
    connectionType: connection.fields.connectionType || null,
    provider: connection.fields.provider || null,
    status: connection.fields.status || null,
    direction: connection.fields.direction || null,
    environment: connection.fields.environment || null,
    to: connection.fields.to || connection.fields.identifier || null,
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const existingConnections = await listProjectConnections(
    options.firebaseProjectId,
    options.collectionName,
  );
  const existingChannelDoc =
    existingConnections.find(
      (connection) =>
        connection.fields.connectionType === 'whatsapp' &&
        connection.fields.provider === 'twilio' &&
        connection.fields.tenantSlug === options.tenantSlug &&
        normalizeConnectionIdentifier(connection.fields.identifier || connection.fields.to) ===
          normalizeConnectionIdentifier(options.to) &&
        String(connection.fields.environment || '') === String(options.environment || ''),
    ) || null;
  const existingSchedulingDocs = existingConnections.filter(
    (connection) =>
      connection.fields.provider === 'firebase' ||
      connection.fields.connectionType === 'scheduling',
  );

  console.log(
    JSON.stringify(
      {
        firebaseProjectId: options.firebaseProjectId,
        runtimeEnvironmentAssumed: options.environment,
        existingSchedulingConnections: existingSchedulingDocs.map(summarizeConnection),
        existingChannelConnection: existingChannelDoc ? summarizeConnection(existingChannelDoc) : null,
      },
      null,
      2,
    ),
  );

  const channelDocument = buildChannelConnectionDocument(options, existingChannelDoc);

  if (options.dryRun) {
    console.log('\nDry run only. Documento que seria aplicado:\n');
    console.log(JSON.stringify(channelDocument, null, 2));
    return;
  }

  const savedDocument = await upsertDocument(
    options.firebaseProjectId,
    options.collectionName,
    options.docId,
    channelDocument,
  );
  const finalConnections = await listProjectConnections(
    options.firebaseProjectId,
    options.collectionName,
  );
  const routingMatches = finalConnections.filter(
    (connection) =>
      connection.fields.tenantSlug === options.tenantSlug &&
      connection.fields.connectionType === 'whatsapp' &&
      connection.fields.provider === 'twilio' &&
      String(connection.fields.environment || '') === String(options.environment || '') &&
      connection.fields.status === 'active' &&
      connection.fields.active !== false &&
      connection.fields.isActive !== false,
  );

  console.log('\nDocumento salvo com sucesso:\n');
  console.log(JSON.stringify(summarizeConnection(savedDocument), null, 2));
  console.log('\nValidação do routing:\n');
  console.log(
    JSON.stringify(
      {
        expectedTenantSlug: options.tenantSlug,
        expectedEnvironment: options.environment,
        routingMatches: routingMatches.map(summarizeConnection),
        routingMatchesCount: routingMatches.length,
      },
      null,
      2,
    ),
  );
}

run().catch((error) => {
  console.error('\nFalha ao sincronizar projectConnections.');
  console.error(
    JSON.stringify(
      {
        message: error.message,
        status: error.status || null,
        body: error.body || null,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
