const {
  ASSISTANT_NAME,
  BUSINESS_ADDRESS,
  BUSINESS_HOURS,
  BUSINESS_NAME,
} = require('./config');

// As mensagens desta etapa foram refinadas para a demo.
// O foco continua sendo receber solicitacoes de atendimento via WhatsApp,
// sem prometer confirmacao imediata do agendamento dentro do bot.
function buildRequestSummary(session) {
  return `- Nome: ${session.data.name}
- Data: ${session.data.date}
- Horário: ${session.data.time}`;
}

function getWelcomeMenuMessage() {
  return `Olá! Aqui é a ${ASSISTANT_NAME}, assistente virtual da ${BUSINESS_NAME}.

Posso te ajudar com informações e com o registro da sua solicitação de atendimento.

Digite o número da opção desejada:
1 - Solicitar atendimento ou agendamento
2 - Horário de atendimento
3 - Endereço
4 - Falar com a equipe`;
}

function getSchedulingWelcomeMessage() {
  return `Perfeito. Vou registrar sua solicitação para a equipe da ${BUSINESS_NAME}.

Para começar, qual é o seu nome completo?`;
}

function getDatePromptMessage(name) {
  return `Perfeito, ${name}.

Qual data você deseja? Envie no formato 25/03 ou 25/03/2026.`;
}

function getTimePromptMessage() {
  return 'Agora me informe o horário desejado no formato 14:00.';
}

function getRequestConfirmationMessage(session) {
  return `Antes de enviar, confira os dados da sua solicitação:

${buildRequestSummary(session)}

Importante: este canal registra sua solicitação. A confirmação do horário é feita pela nossa equipe.

Digite:
1 - Confirmar
2 - Corrigir`;
}

function getRestartSchedulingMessage() {
  return `Sem problema. Vamos refazer sua solicitação desde o início.

Qual é o seu nome completo?`;
}

function getRequestRegisteredMessage(session) {
  return `Sua solicitação foi registrada com sucesso.

${buildRequestSummary(session)}

Nossa equipe vai confirmar a disponibilidade e retornar em breve.

Se quiser continuar, digite menu.`;
}

function getHoursMessage() {
  return `Nosso horário de atendimento é ${BUSINESS_HOURS}.

Se quiser registrar uma solicitação, digite 1 ou envie menu.`;
}

function getAddressMessage() {
  return `Estamos em ${BUSINESS_ADDRESS}.

Se quiser, digite menu para ver as opções novamente.`;
}

function getTalkToTeamMessage() {
  return `Perfeito. Vou registrar que você deseja falar com nossa equipe.

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

function getRegistrationFailureMessage() {
  return 'Houve um problema ao registrar sua solicitação agora. Tente novamente em instantes, por favor. Se quiser, responda 1 para tentar confirmar de novo ou 2 para corrigir os dados.';
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
