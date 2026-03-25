// O bot passa a atuar como um canal conectado ao core oficial.
// DEFAULT_PROJECT_SLUG permite escolher qual projeto do core recebera
// as entradas do WhatsApp sem precisar alterar o Projeto 2 diretamente.
const DEFAULT_PROJECT_SLUG = process.env.DEFAULT_PROJECT_SLUG?.trim() || 'clinica-demo';

const CORE_CHANNEL = 'whatsapp';
const CORE_SOURCE = 'twilio-sandbox';

module.exports = {
  DEFAULT_PROJECT_SLUG,
  CORE_CHANNEL,
  CORE_SOURCE,
};
