const admin = require('firebase-admin');

// No Vercel, FIREBASE_SERVICE_ACCOUNT_KEY deve conter o JSON completo
// da service account do Firebase em uma unica variavel de ambiente.
// FIREBASE_PROJECT_ID tambem deve ser configurada no projeto do bot
// para explicitar o projeto usado pela funcao serverless.
function parseServiceAccountKey() {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!rawServiceAccount) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_KEY nao configurada. Defina o JSON completo da service account nas variaveis de ambiente do projeto na Vercel.',
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

if (!admin.apps.length) {
  const serviceAccount = parseServiceAccountKey();
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || serviceAccount.project_id;

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId,
  });
}

const db = admin.firestore();

module.exports = {
  admin,
  db,
};
