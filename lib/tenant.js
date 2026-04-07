const ACTIVE_TENANT_SLUG = 'clinica-devtec';

function normalizeTenantSlug(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();
  return normalizedValue || null;
}

function isActiveTenantSlug(value) {
  return normalizeTenantSlug(value) === ACTIVE_TENANT_SLUG;
}

module.exports = {
  ACTIVE_TENANT_SLUG,
  isActiveTenantSlug,
  normalizeTenantSlug,
};
