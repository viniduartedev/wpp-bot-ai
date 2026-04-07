// O core continua responsavel por observabilidade e integracao. Nesta fase
// piloto, o runtime do bot trabalha somente com o tenant clinica-devtec.
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
