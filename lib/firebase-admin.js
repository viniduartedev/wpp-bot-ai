const admin = require('firebase-admin');

const BOT_FIREBASE_APP_NAME = 'bot-runtime';
const EXPECTED_BOT_FIREBASE_PROJECT_ID = 'bot-whatsapp-ai-d10ef';

let cachedFirestoreClients = null;

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

// No Vercel, BOT_FIREBASE_SERVICE_ACCOUNT_KEY deve conter o JSON completo
// da service account da base bot-whatsapp-ai. FIREBASE_SERVICE_ACCOUNT_KEY
// segue aceito como fallback temporario para preservar a transicao.
function parseServiceAccountKey() {
  const rawServiceAccount =
    process.env.BOT_FIREBASE_SERVICE_ACCOUNT_KEY || process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!rawServiceAccount) {
    throw new Error(
      'BOT_FIREBASE_SERVICE_ACCOUNT_KEY nao configurada. Defina o JSON completo da service account da base bot-whatsapp-ai nas variaveis de ambiente do projeto na Vercel.',
    );
  }

  let parsedServiceAccount;

  try {
    parsedServiceAccount = JSON.parse(rawServiceAccount);
  } catch (error) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_KEY invalida: ${error.message}`);
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
      'FIREBASE_SERVICE_ACCOUNT_KEY precisa conter project_id, client_email e private_key no JSON da service account.',
    );
  }

  return parsedServiceAccount;
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

function getFirestoreClients() {
  if (cachedFirestoreClients) {
    return cachedFirestoreClients;
  }

  const serviceAccount = parseServiceAccountKey();
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

  cachedFirestoreClients = {
    admin,
    app,
    botDb: app.firestore(),
    db: app.firestore(),
    firebaseProjectId: projectId,
  };

  return cachedFirestoreClients;
}

module.exports = {
  EXPECTED_BOT_FIREBASE_PROJECT_ID,
  getFirestoreClients,
};
