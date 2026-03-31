// O bot agora roteia cada conversa pelo numero de destino do WhatsApp.
// O core continua responsavel por observabilidade e integracao, mas o
// roteamento nao deve depender mais de um projeto padrao fixo.
const CORE_CHANNEL = 'whatsapp';
const CORE_CONNECTION_TYPE = 'whatsapp';
const CORE_PROVIDER = 'twilio';
const CORE_SOURCE = 'twilio-sandbox';
const BOT_RUNTIME_ENV = process.env.BOT_RUNTIME_ENV?.trim() || '';

module.exports = {
  BOT_RUNTIME_ENV,
  CORE_CHANNEL,
  CORE_CONNECTION_TYPE,
  CORE_PROVIDER,
  CORE_SOURCE,
};
