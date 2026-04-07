const admin = require('firebase-admin');

const BOT_FIREBASE_APP_NAME = 'bot-runtime';
const AGENDA_FIREBASE_APP_NAME = 'agenda-operational';
const EXPECTED_BOT_FIREBASE_PROJECT_ID = 'bot-whatsapp-ai-d10ef';
const EXPECTED_AGENDA_FIREBASE_PROJECT_ID = 'agendamento-ai-9fbfb';

let cachedBotFirestoreClients = null;
let cachedAgendaFirestoreClients = null;

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function parseServiceAccountJson(rawServiceAccount, sourceEnvName) {
  let parsedServiceAccount;

  try {
    parsedServiceAccount = JSON.parse(rawServiceAccount);
  } catch (error) {
    throw new Error(`${sourceEnvName} invalida: ${error.message}`);
  }

  if (parsedServiceAccount.private_key) {
    parsedServiceAccount.private_key = parsedServiceAccount.private_key.replace(/\\n/g, '\n');
  }

  if (
    !parsedServiceAccount.project_id ||
    !parsedServiceAccount.client_email ||
    !parsedServiceAccount.private_key
  ) {
    throw new Error(
      `${sourceEnvName} precisa conter project_id, client_email e private_key no JSON da service account.`,
    );
  }

  return parsedServiceAccount;
}

// No Vercel, BOT_FIREBASE_SERVICE_ACCOUNT_KEY deve conter o JSON completo
// da service account da base bot-whatsapp-ai. FIREBASE_SERVICE_ACCOUNT_KEY
// segue aceito como fallback temporario para preservar a transicao.
function parseBotServiceAccountKey() {
  const rawServiceAccount =
    process.env.BOT_FIREBASE_SERVICE_ACCOUNT_KEY || process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const sourceEnvName = process.env.BOT_FIREBASE_SERVICE_ACCOUNT_KEY
    ? 'BOT_FIREBASE_SERVICE_ACCOUNT_KEY'
    : 'FIREBASE_SERVICE_ACCOUNT_KEY';

  if (!rawServiceAccount) {
    throw new Error(
      'BOT_FIREBASE_SERVICE_ACCOUNT_KEY nao configurada. Defina o JSON completo da service account da base bot-whatsapp-ai nas variaveis de ambiente do projeto na Vercel.',
    );
  }

  return parseServiceAccountJson(rawServiceAccount, sourceEnvName);
}

// A leitura operacional de servicos usa explicitamente a base agendamento-ai.
// O fallback AGENDAMENTO_* existe apenas para nomear a mesma base em portugues.
function parseAgendaServiceAccountKey() {
  const rawServiceAccount =
    process.env.AGENDA_FIREBASE_SERVICE_ACCOUNT_KEY ||
    process.env.AGENDAMENTO_FIREBASE_SERVICE_ACCOUNT_KEY;
  const sourceEnvName = process.env.AGENDA_FIREBASE_SERVICE_ACCOUNT_KEY
    ? 'AGENDA_FIREBASE_SERVICE_ACCOUNT_KEY'
    : 'AGENDAMENTO_FIREBASE_SERVICE_ACCOUNT_KEY';

  if (!rawServiceAccount) {
    throw new Error(
      'AGENDA_FIREBASE_SERVICE_ACCOUNT_KEY nao configurada. Defina o JSON completo da service account da base agendamento-ai-9fbfb nas variaveis de ambiente do projeto na Vercel.',
    );
  }

  return parseServiceAccountJson(rawServiceAccount, sourceEnvName);
}

function resolveBotFirebaseProjectId(serviceAccount) {
  const projectId =
    readEnv('BOT_FIREBASE_PROJECT_ID') ||
    readEnv('FIREBASE_PROJECT_ID') ||
    serviceAccount.project_id;

  if (
    projectId !== EXPECTED_BOT_FIREBASE_PROJECT_ID &&
    readEnv('BOT_FIREBASE_ALLOW_UNEXPECTED_PROJECT') !== 'true'
  ) {
    throw new Error(
      `Projeto Firebase invalido para o runtime do bot: ${projectId}. Configure BOT_FIREBASE_PROJECT_ID=${EXPECTED_BOT_FIREBASE_PROJECT_ID} para evitar uso acidental da base agendamento-ai.`,
    );
  }

  return projectId;
}

function resolveAgendaFirebaseProjectId(serviceAccount) {
  const projectId =
    readEnv('AGENDA_FIREBASE_PROJECT_ID') ||
    readEnv('AGENDAMENTO_FIREBASE_PROJECT_ID') ||
    serviceAccount.project_id;

  if (
    projectId !== EXPECTED_AGENDA_FIREBASE_PROJECT_ID &&
    readEnv('AGENDA_FIREBASE_ALLOW_UNEXPECTED_PROJECT') !== 'true' &&
    readEnv('AGENDAMENTO_FIREBASE_ALLOW_UNEXPECTED_PROJECT') !== 'true'
  ) {
    throw new Error(
      `Projeto Firebase invalido para a agenda operacional: ${projectId}. Configure AGENDA_FIREBASE_PROJECT_ID=${EXPECTED_AGENDA_FIREBASE_PROJECT_ID} para ler os servicos reais da agenda.`,
    );
  }

  return projectId;
}

function getFirestoreClients() {
  if (cachedBotFirestoreClients) {
    return cachedBotFirestoreClients;
  }

  const serviceAccount = parseBotServiceAccountKey();
  const projectId = resolveBotFirebaseProjectId(serviceAccount);
  const app =
    admin.apps.find((existingApp) => existingApp.name === BOT_FIREBASE_APP_NAME) ||
    admin.initializeApp(
      {
        credential: admin.credential.cert(serviceAccount),
        projectId,
      },
      BOT_FIREBASE_APP_NAME,
    );

  console.log(`[bot-runtime] firebaseProject=${projectId}`);

  cachedBotFirestoreClients = {
    admin,
    app,
    botDb: app.firestore(),
    db: app.firestore(),
    firebaseProjectId: projectId,
  };

  return cachedBotFirestoreClients;
}

function getAgendaFirestoreClient() {
  if (cachedAgendaFirestoreClients) {
    return cachedAgendaFirestoreClients;
  }

  const serviceAccount = parseAgendaServiceAccountKey();
  const projectId = resolveAgendaFirebaseProjectId(serviceAccount);
  const app =
    admin.apps.find((existingApp) => existingApp.name === AGENDA_FIREBASE_APP_NAME) ||
    admin.initializeApp(
      {
        credential: admin.credential.cert(serviceAccount),
        projectId,
      },
      AGENDA_FIREBASE_APP_NAME,
    );

  console.log(`[bot-runtime] agendaFirebaseProject=${projectId}`);

  cachedAgendaFirestoreClients = {
    admin,
    app,
    agendaDb: app.firestore(),
    db: app.firestore(),
    agendaFirebaseProjectId: projectId,
    firebaseProjectId: projectId,
  };

  return cachedAgendaFirestoreClients;
}

module.exports = {
  EXPECTED_AGENDA_FIREBASE_PROJECT_ID,
  EXPECTED_BOT_FIREBASE_PROJECT_ID,
  getAgendaFirestoreClient,
  getFirestoreClients,
};
