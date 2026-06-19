# Sistema de Agendamento — Óticas Target

Sistema multiloja de agendamentos e gestão de OS.  
**Stack:** Node.js + Express → proxy para Google Apps Script (GAS)

---

## Estrutura do Projeto

```
agendamento-system/
├── server.js              # Express: serve frontend + proxy para GAS
├── package.json
├── railway.toml           # Deploy Railway
├── .env.example           # Variáveis de ambiente (copie para .env)
├── .gitignore
├── GAS_API_PATCH.js       # Patch a aplicar no código.gs (GAS)
└── public/
    └── index.html         # Frontend completo (mesmas cores e efeitos)
```

---

## Setup Local (VS Code)

### 1. Clonar e instalar dependências

```bash
git clone https://github.com/SEU_USUARIO/agendamento-system.git
cd agendamento-system
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Edite o `.env`:
```
GAS_DEPLOY_URL=https://script.google.com/macros/s/AKfycb.../exec
GAS_API_KEY=uma-chave-secreta-forte-aqui
SESSION_SECRET=um-segredo-aleatorio-diferente-com-32-ou-mais-caracteres
SESSION_TTL_HOURS=12
```

### 3. Aplicar patch no Google Apps Script

Abra `GAS_API_PATCH.js` e siga as instruções dentro do arquivo:
- Adicione o bloco `formato === 'api'` dentro de `doGet`
- Cole a função `handleHttpApiCall_` ao final do `código.gs`
- Configure a chave no GAS:
  ```js
  PropertiesService.getScriptProperties()
    .setProperty('API_KEY', 'mesma-chave-do-env');
  ```
- Re-publique o deploy do GAS (nova versão)

### 4. Rodar localmente

```bash
npm run dev    # com hot-reload (nodemon)
# ou
npm start      # produção
```

Acesse: **http://localhost:3000**

---

## Deploy Railway

1. Faça push para o GitHub
2. Crie um novo projeto no [Railway](https://railway.app)
3. Conecte ao repositório GitHub
4. Adicione as variáveis de ambiente no Railway:
   - `DATABASE_URL` (normalmente fornecida pelo serviço PostgreSQL)
   - `GAS_DEPLOY_URL`
   - `GAS_API_KEY`
   - `SESSION_SECRET`
   - `SESSION_TTL_HOURS`
5. O Railway detecta automaticamente o `railway.toml` e faz deploy

---

## Variáveis de Ambiente

| Variável | Descrição | Obrigatório |
|---|---|---|
| `PORT` | Porta local (Railway define automaticamente) | Não |
| `GAS_DEPLOY_URL` | URL de deploy do Apps Script | **Sim** |
| `GAS_API_KEY` | Chave secreta para autenticar chamadas | **Sim** |
| `SESSION_SECRET` | Assina cookies de sessão; use valor aleatório com 32+ caracteres | **Sim** |
| `SESSION_TTL_HOURS` | Duração da sessão; padrão 12 horas | Não |
| `ALLOWED_ORIGINS` | Origens CORS separadas por vírgula | Não |

Cada usuário entra com e-mail e senha individual armazenada como hash bcrypt. As rotas internas em `/api/*` exigem cookie de sessão assinado. Somente `/api/auth/login`,
`/api/auth/logout` e `/api/public/*` ficam fora dessa exigência. Perfis e lojas também são
validados no servidor; esconder botões no navegador não é tratado como controle de segurança.

---

## Como Funciona

```
Browser → Node.js (Express) → GAS (doGet?format=api)
         └── /api/gas          └── handleHttpApiCall_
              POST                  retorna { ok, result }
         └── /public/index.html
```

O frontend usa `fetch('/api/gas', { fn, args })` em vez de  
`google.script.run` — mesma lógica, sem depender do GAS Editor.

---

## Patches Aplicados (v7.2.0)

- ✅ Fix crítico: `configurarSegredosKommo` com chaves corretas
- ✅ Gerente de Loja: `getInfoInicial(email)` filtra owners por loja
- ✅ Botões **Comprou / Não Comprou** adicionados na tabela
- ✅ Modal de OS profissional substitui `window.prompt()`

---

## Desenvolvimento

```bash
# Instalar dependências
npm install

# Rodar em modo dev (reinicia ao salvar)
npm run dev

# Verificar saúde da API
curl http://localhost:3000/health
```
