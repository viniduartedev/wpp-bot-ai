const { BUSINESS_ADDRESS, BUSINESS_HOURS, BUSINESS_NAME } = require('./config');

// As mensagens desta etapa foram refinadas para a demo.
// O foco continua sendo receber solicitacoes de atendimento via WhatsApp,
// sem prometer confirmacao imediata do agendamento dentro do bot.
function buildRequestSummary(session) {
  return `Nome: ${session.data.name}
Data: ${session.data.date}
Horário: ${session.data.time}`;
}

function getWelcomeMenuMessage() {
  return `Olá! Você está falando com o atendimento virtual da ${BUSINESS_NAME}.

Como posso te ajudar hoje?

1 - Solicitar atendimento ou agendamento
2 - Horário de atendimento
3 - Endereço
4 - Falar com a equipe`;
}

function getSchedulingWelcomeMessage() {
  return `Perfeito. Vou registrar sua solicitação de atendimento.

Qual é o seu nome completo?`;
}

function getDatePromptMessage(name) {
  return `Obrigado, ${name}.

Qual data você deseja? Informe no formato 25/03 ou 25/03/2026.`;
}

function getTimePromptMessage() {
  return 'Agora me informe o horário desejado no formato 14:00.';
}

function getRequestConfirmationMessage(session) {
  return `Confirma os dados da sua solicitação?

${buildRequestSummary(session)}

Essa solicitação será analisada pela nossa equipe antes da confirmação do horário.

Digite:
1 - Confirmar
2 - Corrigir`;
}

function getRestartSchedulingMessage() {
  return `Sem problema. Vamos atualizar sua solicitação.

Qual é o seu nome completo?`;
}

function getRequestRegisteredMessage(session) {
  return `Recebi sua solicitação de atendimento com sucesso.

${buildRequestSummary(session)}

Nossa equipe vai confirmar a disponibilidade e retornar em breve.

Se precisar de algo mais, digite menu.`;
}

function getHoursMessage() {
  return `Nosso horário de atendimento é ${BUSINESS_HOURS}.

Se quiser registrar uma solicitação, digite 1 ou envie menu.`;
}

function getAddressMessage() {
  return `Nosso endereço é ${BUSINESS_ADDRESS}.

Se quiser, digite menu para ver as opções novamente.`;
}

function getTalkToTeamMessage() {
  return `Perfeito. Você pode enviar sua dúvida por aqui e nossa equipe dará continuidade ao atendimento assim que possível.

Se preferir, digite menu para ver as opções disponíveis.`;
}

function getNameValidationMessage() {
  return 'Não consegui identificar seu nome. Por favor, me informe seu nome completo para continuar.';
}

function getDateValidationMessage() {
  return 'Não consegui entender a data. Por favor, informe no formato 25/03 ou 25/03/2026.';
}

function getTimeValidationMessage() {
  return 'Não consegui entender o horário. Por favor, informe no formato 14:00.';
}

function getConfirmationChoiceErrorMessage() {
  return 'Para continuar, digite 1 para confirmar ou 2 para corrigir os dados da solicitação.';
}

function getConversationFallbackMessage() {
  return 'Não consegui identificar essa opção. Digite o número desejado ou envie menu para ver as opções novamente.';
}

function getRegistrationFailureMessage() {
  return 'Houve um problema ao registrar sua solicitação agora. Tente novamente em instantes, por favor.';
}

module.exports = {
  getAddressMessage,
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
  getSchedulingWelcomeMessage,
  getTalkToTeamMessage,
  getTimePromptMessage,
  getTimeValidationMessage,
  getWelcomeMenuMessage,
};
