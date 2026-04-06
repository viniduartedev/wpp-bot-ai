const DEFAULT_DEMO_SERVICES = [
  { key: 'consulta', label: 'Consulta' },
  { key: 'retorno', label: 'Retorno' },
  { key: 'exame', label: 'Exame' },
];

const PROJECT_SERVICE_FIELD_CANDIDATES = [
  ['services'],
  ['serviceCatalog'],
  ['serviceOptions'],
  ['settings', 'services'],
  ['config', 'services'],
];

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

function slugifyServiceKey(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeTenantSlug(value) {
  return String(value || '').trim().toLowerCase();
}

function getValueAtPath(source, path) {
  return path.reduce((currentValue, key) => currentValue?.[key], source);
}

function buildServiceSearchTerms(service) {
  const searchTerms = new Set();

  if (service.key) {
    searchTerms.add(normalizeText(service.key));
  }

  if (service.label) {
    searchTerms.add(normalizeText(service.label));
  }

  for (const alias of service.aliases || []) {
    const normalizedAlias = normalizeText(alias);

    if (normalizedAlias) {
      searchTerms.add(normalizedAlias);
    }
  }

  return Array.from(searchTerms).filter(Boolean);
}

function normalizeServiceEntry(rawService, index) {
  if (typeof rawService === 'string') {
    const label = collapseWhitespace(rawService);
    const key = slugifyServiceKey(label);

    if (!label || !key) {
      return null;
    }

    return {
      key,
      label,
      aliases: [],
    };
  }

  if (!rawService || typeof rawService !== 'object') {
    return null;
  }

  const label = collapseWhitespace(rawService.label || rawService.name || rawService.title);
  const key = slugifyServiceKey(rawService.key || label || `service_${index + 1}`);
  const aliases = Array.isArray(rawService.aliases)
    ? rawService.aliases
        .map((alias) => collapseWhitespace(alias))
        .filter(Boolean)
    : [];

  if (!label || !key) {
    return null;
  }

  return {
    key,
    label,
    aliases,
  };
}

function normalizeServiceList(rawServices) {
  if (!Array.isArray(rawServices)) {
    return [];
  }

  const services = [];
  const seenKeys = new Set();

  rawServices.forEach((rawService, index) => {
    const normalizedService = normalizeServiceEntry(rawService, index);

    if (!normalizedService || seenKeys.has(normalizedService.key)) {
      return;
    }

    seenKeys.add(normalizedService.key);
    services.push(normalizedService);
  });

  return services;
}

function parseProjectServicesFallbackEnv() {
  const rawConfig = String(process.env.BOT_PROJECT_SERVICES_JSON || '').trim();

  if (!rawConfig) {
    return {};
  }

  try {
    const parsedConfig = JSON.parse(rawConfig);
    return parsedConfig && typeof parsedConfig === 'object' ? parsedConfig : {};
  } catch (error) {
    console.warn('[services] BOT_PROJECT_SERVICES_JSON invalido. Ignorando fallback configurado.', {
      message: error.message,
    });
    return {};
  }
}

function resolveProjectConfiguredServices(project) {
  for (const path of PROJECT_SERVICE_FIELD_CANDIDATES) {
    const rawServices = getValueAtPath(project, path);

    if (typeof rawServices === 'undefined') {
      continue;
    }

    return {
      services: normalizeServiceList(rawServices),
      path: path.join('.'),
      hasConfiguredPath: true,
    };
  }

  return {
    services: [],
    path: null,
    hasConfiguredPath: false,
  };
}

function buildProjectLookupKeys(project, tenantSlug) {
  const normalizedTenantSlug = normalizeTenantSlug(tenantSlug || project?.tenantSlug || project?.slug);
  const projectId = collapseWhitespace(project?.id);
  const projectSlug = normalizeTenantSlug(project?.slug);
  const projectName = normalizeText(project?.name);
  const keys = [normalizedTenantSlug, projectId, projectSlug, projectName, 'default']
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return Array.from(new Set(keys));
}

function resolveFallbackServices(project, options = {}) {
  const configuredFallbacks = parseProjectServicesFallbackEnv();
  const lookupKeys = buildProjectLookupKeys(project, options.tenantSlug);

  for (const lookupKey of lookupKeys) {
    const fallbackServices = normalizeServiceList(configuredFallbacks[lookupKey]);

    if (fallbackServices.length > 0) {
      return {
        services: fallbackServices,
        lookupKey,
        source: 'bot_fallback_env',
      };
    }
  }

  return {
    services: DEFAULT_DEMO_SERVICES.map((service) => ({ ...service })),
    lookupKey: 'default',
    source: 'bot_fallback_default',
  };
}

function loadProjectServices(project, options = {}) {
  const configuredServices = resolveProjectConfiguredServices(project);
  const resolvedTenantSlug = normalizeTenantSlug(
    options.tenantSlug || project?.tenantSlug || project?.slug,
  );

  if (configuredServices.services.length > 0) {
    return {
      services: configuredServices.services,
      tenantSlug: resolvedTenantSlug || null,
      source: 'project',
      resolvedFrom: configuredServices.path,
      usedFallback: false,
    };
  }

  if (configuredServices.hasConfiguredPath) {
    console.warn('[services] Projeto com configuracao de servicos vazia ou invalida. Aplicando fallback.', {
      projectId: project?.id || null,
      projectSlug: project?.slug || null,
      configuredPath: configuredServices.path,
    });
  }

  const fallback = resolveFallbackServices(project, {
    tenantSlug: resolvedTenantSlug,
  });

  return {
    services: fallback.services,
    tenantSlug: resolvedTenantSlug || null,
    source: fallback.source,
    resolvedFrom: fallback.lookupKey,
    usedFallback: true,
  };
}

function formatServiceOptionsList(services) {
  return services.map((service, index) => `${index + 1} - ${service.label}`).join('\n');
}

function resolveServiceSelection(value, services) {
  const cleanedValue = collapseWhitespace(value);
  const normalizedValue = normalizeText(cleanedValue);

  if (!Array.isArray(services) || services.length === 0) {
    return {
      isValid: false,
      code: 'services_unavailable',
      value: cleanedValue,
      service: null,
    };
  }

  if (!normalizedValue) {
    return {
      isValid: false,
      code: 'empty_selection',
      value: cleanedValue,
      service: null,
    };
  }

  if (/^\d+$/.test(normalizedValue)) {
    const selectedIndex = Number(normalizedValue) - 1;
    const selectedService = services[selectedIndex] || null;

    return {
      isValid: Boolean(selectedService),
      code: selectedService ? null : 'invalid_index',
      value: cleanedValue,
      service: selectedService,
    };
  }

  const selectedService =
    services.find((service) => buildServiceSearchTerms(service).includes(normalizedValue)) || null;

  return {
    isValid: Boolean(selectedService),
    code: selectedService ? null : 'invalid_value',
    value: cleanedValue,
    service: selectedService,
  };
}

function normalizeSelectedService(service) {
  if (!service) {
    return null;
  }

  const normalizedService = normalizeServiceEntry(service, 0);

  if (!normalizedService) {
    return null;
  }

  return {
    key: normalizedService.key,
    label: normalizedService.label,
  };
}

module.exports = {
  DEFAULT_DEMO_SERVICES,
  formatServiceOptionsList,
  loadProjectServices,
  normalizeSelectedService,
  normalizeServiceList,
  resolveServiceSelection,
};
