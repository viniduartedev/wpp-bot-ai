const {
  ASSISTANT_NAME,
  BUSINESS_ADDRESS,
  BUSINESS_HOURS,
  BUSINESS_NAME,
} = require('./config');
const { getEnabledMenuOptions } = require('./profile');
const { formatServiceOptionsList } = require('./services');

// As mensagens desta etapa foram refinadas para a demo.
// O foco continua sendo receber solicitacoes de atendimento via WhatsApp,
// sem prometer confirmacao imediata do agendamento dentro do bot.
function buildRequestSummary(session) {
  return `- Serviço: ${session.data.selectedServiceLabel || 'Não informado'}
- Nome: ${session.data.name}
- Data: ${session.data.date}
- Horário: ${session.data.time}`;
}

function getAssistantName(botProfile) {
  return String(botProfile?.assistantName || '').trim() || ASSISTANT_NAME;
}

function getBusinessName(botProfile) {
  return String(botProfile?.businessName || '').trim() || BUSINESS_NAME;
}

function buildDynamicMenu(botProfile) {
  const enabledOptions = getEnabledMenuOptions(botProfile);

  return enabledOptions
    .map((option, index) => `${index + 1} - ${option.label}`)
    .join('\n');
}

function getWelcomeMenuMessage(botProfile) {
  const welcomeMessage =
    String(botProfile?.welcomeMessage || '').trim() ||
    `Olá! Aqui é ${getAssistantName(botProfile)}, assistente virtual da ${getBusinessName(botProfile)}. Posso te ajudar com informações e com o registro da sua solicitação de atendimento.`;
  const dynamicMenu = buildDynamicMenu(botProfile);

  if (!dynamicMenu) {
    return `${welcomeMessage}

No momento, as opções automáticas deste canal estão indisponíveis.`;
  }

  return `${welcomeMessage}

Digite o número da opção desejada:
${dynamicMenu}`;
}

function buildServiceSelectionPrompt(services) {
  if (!Array.isArray(services) || services.length === 0) {
    return 'No momento não consegui carregar os serviços disponíveis. Tente novamente em instantes, por favor.';
  }

  return `Qual serviço você deseja?
${formatServiceOptionsList(services)}`;
}

function getSchedulingWelcomeMessage(botProfile, services) {
  return `Perfeito. Vou registrar sua solicitação para a equipe da ${getBusinessName(botProfile)}.

${buildServiceSelectionPrompt(services)}`;
}

function getServiceSelectionErrorMessage(services) {
  return `Não consegui identificar a opção escolhida. Por favor, responda com o número do serviço desejado.

${buildServiceSelectionPrompt(services)}`;
}

function getServiceUnavailableMessage() {
  return 'No momento não consegui carregar os serviços disponíveis. Tente novamente em instantes, por favor.';
}

function getNamePromptMessage(botProfile, serviceLabel) {
  return `Perfeito, você escolheu: ${serviceLabel}.

Agora me informe o seu nome completo.`;
}

function getDatePromptMessage(botProfile, name) {
  return `Perfeito, ${name}.

Qual data você deseja? Envie no formato 25/03 ou 25/03/2026.`;
}

function getTimePromptMessage(botProfile) {
  return 'Agora me informe o horário desejado no formato 14:00.';
}

function getRequestConfirmationMessage(botProfile, session) {
  return `Antes de enviar, confira os dados da sua solicitação:

${buildRequestSummary(session)}

Importante: este canal registra sua solicitação. A confirmação do horário é feita pela nossa equipe.

Digite:
1 - Confirmar
2 - Corrigir`;
}

function getRestartSchedulingMessage(botProfile) {
  return `Sem problema. Vamos refazer sua solicitação desde o início.

Qual serviço você deseja?`;
}

function getRequestRegisteredMessage(botProfile, session) {
  const closingMessage =
    String(botProfile?.closingMessage || '').trim() ||
    'Recebemos sua solicitação e nossa equipe vai confirmar os próximos passos em breve.';

  return `Sua solicitação foi registrada com sucesso.

${buildRequestSummary(session)}

A confirmação do horário é feita pela nossa equipe.
${closingMessage}

Se quiser continuar, digite menu.`;
}

function getHoursMessage(botProfile) {
  return `O horário de atendimento da ${getBusinessName(botProfile)} é ${BUSINESS_HOURS}.

Se quiser continuar, digite menu para ver as opções disponíveis.`;
}

function getAddressMessage(botProfile) {
  return `${getBusinessName(botProfile)} está em ${BUSINESS_ADDRESS}.

Se quiser, digite menu para ver as opções novamente.`;
}

function getTalkToTeamMessage(botProfile) {
  return `Perfeito. Vou registrar que você deseja falar com a equipe da ${getBusinessName(botProfile)}.

Se quiser adiantar, pode enviar sua dúvida por aqui e o retorno será feito em breve.

Se preferir, digite menu para ver as opções disponíveis.`;
}

function getNameValidationMessage() {
  return 'Para continuar, preciso do seu nome. Se puder, envie nome e sobrenome.';
}

function getDateValidationMessage() {
  return 'Não consegui entender a data. Por favor, informe no formato 25/03 ou 25/03/2026.';
}

function getTimeValidationMessage() {
  return 'Não consegui entender o horário. Por favor, informe no formato 14:00.';
}

function getConfirmationChoiceErrorMessage() {
  return 'Para continuar, responda 1 para confirmar ou 2 para corrigir os dados da solicitação.';
}

function getConversationFallbackMessage() {
  return 'Não identifiquei essa opção. Escolha um número do menu ou digite menu para começar novamente.';
}

function getChannelUnavailableMessage(botProfile) {
  return 'No momento este canal não está disponível. Tente novamente mais tarde, por favor.';
}

function getRegistrationFailureMessage(botProfile) {
  return 'Houve um problema ao registrar sua solicitação agora. Tente novamente em instantes, por favor. Se quiser, responda 1 para tentar confirmar de novo ou 2 para corrigir os dados.';
}

module.exports = {
  getAddressMessage,
  getChannelUnavailableMessage,
  getConfirmationChoiceErrorMessage,
  getConversationFallbackMessage,
  getDatePromptMessage,
  getDateValidationMessage,
  getHoursMessage,
  getNameValidationMessage,
  getRegistrationFailureMessage,
  getRequestConfirmationMessage,
  getRequestRegisteredMessage,
  getRestartSchedulingMessage,
  getServiceSelectionErrorMessage,
  getServiceUnavailableMessage,
  getSchedulingWelcomeMessage,
  getTalkToTeamMessage,
  getNamePromptMessage,
  getTimePromptMessage,
  getTimeValidationMessage,
  getWelcomeMenuMessage,
};
