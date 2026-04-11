# wpp-bot-ai

Runtime Twilio/WhatsApp do bot. A partir desta fase, o runtime usa o Firebase
`bot-whatsapp-ai-d10ef` como dominio conversacional do bot/core e le os
servicos reais na base operacional `agendamento-ai-9fbfb`.

## Firebase

Configure o runtime com variaveis explicitas do bot:

```env
BOT_FIREBASE_PROJECT_ID=bot-whatsapp-ai-d10ef
BOT_FIREBASE_SERVICE_ACCOUNT_KEY={...json da service account do projeto bot-whatsapp-ai-d10ef...}
AGENDA_FIREBASE_PROJECT_ID=agendamento-ai-9fbfb
AGENDA_FIREBASE_SERVICE_ACCOUNT_KEY={...json da service account do projeto agendamento-ai-9fbfb...}
BOT_RUNTIME_ENV=dev
ENABLE_DEV_COMMANDS=true
```

`FIREBASE_PROJECT_ID` e `FIREBASE_SERVICE_ACCOUNT_KEY` continuam aceitos apenas
como fallback temporario. Para evitar uso acidental da agenda operacional, o
runtime bloqueia qualquer projeto diferente de `bot-whatsapp-ai-d10ef`, exceto
se `BOT_FIREBASE_ALLOW_UNEXPECTED_PROJECT=true` for definido explicitamente.

## ProjectConnections

O projeto `bot-whatsapp-ai-d10ef` precisa manter dois tipos distintos de
`projectConnections`:

1. Canal do bot:
   `connectionType=whatsapp`, `provider=twilio`, `direction=inbound`
   Esse documento e o que o runtime usa para resolver o canal do WhatsApp.
   Para o sandbox atual, o documento deve incluir:

```json
{
  "tenantSlug": "clinica-devtec",
  "tenantId": "demo-tenant",
  "projectId": "core-project-clinica-devtec",
  "connectionType": "whatsapp",
  "provider": "twilio",
  "status": "active",
  "active": true,
  "isActive": true,
  "direction": "inbound",
  "identifier": "whatsapp:+14155238886",
  "to": "whatsapp:+14155238886",
  "environment": "dev",
  "acceptedEventTypes": ["message"]
}
```

2. Integracao operacional:
   `connectionType=scheduling`, `provider=firebase`, `direction=outbound`
   Esse documento continua valido para a materializacao do appointment em
   `agendamento-ai-9fbfb` e nao deve ser removido.

Para sincronizar a conexao de canal do bot sem tocar na conexao operacional,
use:

```bash
firebase projects:list
npm run project-connections:upsert
```

O script usa a autenticacao ja ativa no Firebase CLI, preserva a conexao
Firebase/agendamento existente e faz o upsert apenas do documento Twilio.

## Fluxo piloto

O runtime opera temporariamente com um unico tenant ativo: `clinica-devtec`.
O comando `/dev clinica-devtec` continua aceito no WhatsApp Sandbox, mas outros
slugs sao rejeitados nesta fase.

1. Envie `/dev clinica-devtec` no WhatsApp Sandbox, se precisar reiniciar o contexto dev.
2. O runtime grava sempre `session.tenantSlug=clinica-devtec` em `botDb/sessions`.
3. Ao iniciar agendamento, os servicos ativos sao lidos de
   `agendamento-ai-9fbfb/services` via `agendaDb`, filtrando somente
   `tenantSlug=clinica-devtec`.
4. Ao confirmar, o runtime cria `serviceRequests` em `bot-whatsapp-ai-d10ef`
   com `tenantSlug=clinica-devtec`, `service.key` e `service.label`.
5. O core segue responsavel por integrar o appointment operacional em
   `agendamento-ai-9fbfb`.

Logs esperados na homologacao:

```txt
[bot-runtime] firebaseProject=bot-whatsapp-ai-d10ef
[bot-runtime] agendaFirebaseProject=agendamento-ai-9fbfb
[bot] servicesSource=agendamento-ai-9fbfb
[bot] tenantSelected=clinica-devtec
[bot] servicesLoaded=<n>
[bot] serviceSelected=<key>
[bot] serviceRequestCreated=<id>
```
