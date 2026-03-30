// Configuracoes textuais do canal WhatsApp.
// Nesta etapa priorizamos uma demo mais convincente do fluxo de entrada,
// mantendo o bot como canal de recepcao de solicitacoes.
const BUSINESS_NAME = process.env.BOT_BUSINESS_NAME?.trim() || 'Clínica Aurora';
const BUSINESS_HOURS =
  process.env.BOT_BUSINESS_HOURS?.trim() || 'segunda a sexta, das 08:00 às 18:00';
const BUSINESS_ADDRESS =
  process.env.BOT_BUSINESS_ADDRESS?.trim() || 'Av. Central, 123 - Centro';

module.exports = {
  BUSINESS_NAME,
  BUSINESS_HOURS,
  BUSINESS_ADDRESS,
};
