# wpp-bot-ai

Runtime Twilio/WhatsApp do bot. A partir desta fase, o runtime usa o Firebase
`bot-whatsapp-ai-d10ef` como dominio conversacional do bot/core.

## Firebase

Configure o runtime com variaveis explicitas do bot:

```env
BOT_FIREBASE_PROJECT_ID=bot-whatsapp-ai-d10ef
BOT_FIREBASE_SERVICE_ACCOUNT_KEY={...json da service account do projeto bot-whatsapp-ai-d10ef...}
BOT_RUNTIME_ENV=dev
ENABLE_DEV_COMMANDS=true
```

`FIREBASE_PROJECT_ID` e `FIREBASE_SERVICE_ACCOUNT_KEY` continuam aceitos apenas
como fallback temporario. Para evitar uso acidental da agenda operacional, o
runtime bloqueia qualquer projeto diferente de `bot-whatsapp-ai-d10ef`, exceto
se `BOT_FIREBASE_ALLOW_UNEXPECTED_PROJECT=true` for definido explicitamente.

## Fluxo piloto

1. Envie `/dev clinica-devtec` no WhatsApp Sandbox.
2. O runtime grava `session.tenantSlug=clinica-devtec` em `botDb/sessions`.
3. Ao iniciar agendamento, os servicos ativos sao lidos de `botDb/services`.
4. Ao confirmar, o runtime cria `serviceRequests` em `bot-whatsapp-ai-d10ef`
   com `tenantSlug`, `service.key` e `service.label`.
5. O core segue responsavel por integrar o appointment operacional em
   `agendamento-ai-9fbfb`.

Logs esperados na homologacao:

```txt
[bot-runtime] firebaseProject=bot-whatsapp-ai-d10ef
[bot] tenantSelected=clinica-devtec
[bot] servicesLoaded=<n>
[bot] serviceSelected=<key>
[bot] serviceRequestCreated=<id>
```
