const {
  ASSISTANT_NAME,
  BUSINESS_NAME,
} = require('./config');

const MENU_KEY_ORDER = ['schedule', 'hours', 'address', 'human'];

const MENU_DEFAULT_LABELS = {
  schedule: 'Solicitar atendimento ou agendamento',
  hours: 'Horário de atendimento',
  address: 'Endereço',
  human: 'Falar com a equipe',
};

const MENU_KEYWORDS = {
  schedule: [
    'agendar',
    'agendamento',
    'quero agendar',
    'quero marcar',
    'marcar consulta',
    'marcar horario',
    'solicitar atendimento',
    'solicitar agendamento',
  ],
  hours: ['horario', 'horarios', 'funcionamento', 'horario de atendimento'],
  address: ['endereco', 'localizacao', 'onde fica'],
  human: ['falar com a equipe', 'falar com atendente', 'atendente', 'humano'],
};

function collapseWhitespace(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function buildDefaultMenuOptions() {
  return MENU_KEY_ORDER.map((key) => ({
    key,
    label: MENU_DEFAULT_LABELS[key],
    enabled: true,
  }));
}

function getDefaultTone() {
  return 'professional';
}

function buildDefaultWelcomeMessage({ assistantName, businessName, tone }) {
  if (tone === 'friendly') {
    return `Olá! Aqui é ${assistantName}, assistente virtual da ${businessName}. Posso te ajudar com informações e com o registro da sua solicitação.`;
  }

  if (tone === 'neutral') {
    return `Olá! Você está falando com ${businessName}. Posso te ajudar com informações e com o registro da sua solicitação.`;
  }

  return `Olá! Aqui é ${assistantName}, assistente virtual da ${businessName}. Posso te ajudar com informações e com o registro da sua solicitação de atendimento.`;
}

function buildDefaultClosingMessage({ tone }) {
  if (tone === 'friendly') {
    return 'Recebemos sua solicitação por aqui e nossa equipe vai retornar em breve.';
  }

  if (tone === 'neutral') {
    return 'Sua solicitação foi recebida e nossa equipe fará o retorno em breve.';
  }

  return 'Recebemos sua solicitação e nossa equipe vai confirmar os próximos passos em breve.';
}

function normalizeMenuOptions(rawMenuOptions, fallbackFields) {
  const menuOptionsByKey = new Map(
    buildDefaultMenuOptions().map((option) => [option.key, option]),
  );

  if (!Array.isArray(rawMenuOptions)) {
    fallbackFields.push('menuOptions');
    return Array.from(menuOptionsByKey.values());
  }

  for (const rawOption of rawMenuOptions) {
    if (!rawOption || typeof rawOption !== 'object') {
      continue;
    }

    const key = String(rawOption.key || '').trim();

    if (!MENU_KEY_ORDER.includes(key)) {
      continue;
    }

    const label = collapseWhitespace(rawOption.label);
    const currentOption = menuOptionsByKey.get(key);

    menuOptionsByKey.set(key, {
      key,
      label: label || currentOption.label,
      enabled: rawOption.enabled !== false,
    });
  }

  const normalizedMenuOptions = MENU_KEY_ORDER.map((key) => ({
    ...menuOptionsByKey.get(key),
  }));

  if (!normalizedMenuOptions.some((option) => option.enabled)) {
    fallbackFields.push('menuOptions');
    return buildDefaultMenuOptions();
  }

  return normalizedMenuOptions;
}

// `BotProfile` passa a ser a principal camada de personalizacao do bot por projeto.
// Isso permite que um unico motor de conversa atenda multiplos clientes com
// identidade propria, enquanto fluxos mais avancados entram em etapas futuras.
function buildEffectiveBotProfile({ project, botProfile }) {
  const fallbackFields = [];
  const tone =
    ['professional', 'friendly', 'neutral'].includes(botProfile?.tone)
      ? botProfile.tone
      : getDefaultTone();
  const defaultBusinessName = collapseWhitespace(project?.name) || BUSINESS_NAME;
  const assistantName = collapseWhitespace(botProfile?.assistantName) || ASSISTANT_NAME;
  const businessName = collapseWhitespace(botProfile?.businessName) || defaultBusinessName;

  if (!collapseWhitespace(botProfile?.assistantName)) {
    fallbackFields.push('assistantName');
  }

  if (!collapseWhitespace(botProfile?.businessName)) {
    fallbackFields.push('businessName');
  }

  if (!['professional', 'friendly', 'neutral'].includes(botProfile?.tone)) {
    fallbackFields.push('tone');
  }

  const menuOptions = normalizeMenuOptions(botProfile?.menuOptions, fallbackFields);
  const welcomeMessage =
    collapseWhitespace(botProfile?.welcomeMessage) ||
    buildDefaultWelcomeMessage({ assistantName, businessName, tone });
  const closingMessage =
    collapseWhitespace(botProfile?.closingMessage) ||
    buildDefaultClosingMessage({ tone });

  if (!collapseWhitespace(botProfile?.welcomeMessage)) {
    fallbackFields.push('welcomeMessage');
  }

  if (!collapseWhitespace(botProfile?.closingMessage)) {
    fallbackFields.push('closingMessage');
  }

  return {
    id: botProfile?.id || null,
    projectId: project?.id || botProfile?.projectId || null,
    assistantName,
    businessName,
    welcomeMessage,
    closingMessage,
    tone,
    active: botProfile?.active !== false,
    menuOptions,
    fallbackUsed: !botProfile || fallbackFields.length > 0,
    fallbackFields: Array.from(new Set(fallbackFields)),
    source: !botProfile ? 'fallback' : fallbackFields.length > 0 ? 'mixed' : 'project',
  };
}

function getEnabledMenuOptions(botProfile) {
  return Array.isArray(botProfile?.menuOptions)
    ? botProfile.menuOptions.filter((option) => option.enabled !== false)
    : [];
}

function resolveMenuOptionKey(messageText, botProfile) {
  const normalizedText = normalizeText(messageText);
  const enabledOptions = getEnabledMenuOptions(botProfile);

  if (!normalizedText || enabledOptions.length === 0) {
    return null;
  }

  if (/^\d+$/.test(normalizedText)) {
    const selectedIndex = Number(normalizedText) - 1;
    return enabledOptions[selectedIndex]?.key || null;
  }

  const matchingOption = enabledOptions.find((option) =>
    MENU_KEYWORDS[option.key].some((keyword) => normalizedText.includes(keyword)),
  );

  return matchingOption?.key || null;
}

module.exports = {
  buildEffectiveBotProfile,
  getEnabledMenuOptions,
  resolveMenuOptionKey,
};
