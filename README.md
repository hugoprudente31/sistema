# Sistema de Agendamento — Óticas Target

Sistema multiloja de agendamento de avaliação visual e gestão de OS
(ordem de serviço), usado pelas 4 lojas do grupo (Gonzaga, Enseada,
Pitangueiras, Ademar de Barros).

**Stack:** Node.js + Express (monólito, `server.js`) servindo um
front-end em HTML/JS puro (`public/index.html`, sem build step) e um
Postgres como fonte de verdade de todo o dado do sistema. Integração
com o Kommo CRM (bot de WhatsApp, lembretes automáticos, recuperação de
leads frios) e com outros apps do ecossistema (AdAnalyzer, captação de
leads) via chaves de API compartilhadas.

---

## Estrutura do Projeto

```
github-sistema/
├── server.js               # Express: rotas da API + serve o front-end
├── package.json
├── railway.toml             # Deploy Railway
├── env.example               # Variáveis de ambiente (copie para .env)
├── kommo/                    # Bot de WhatsApp, webhooks, lembretes, recuperação
├── database/                  # Referência do schema (fonte real é initDatabase() em server.js)
├── test/                       # Testes automatizados (mockados, rápidos, sem rede)
├── test/integration/            # Testes de integração — Postgres real, opt-in
└── public/
    └── index.html                # Painel completo (SPA sem framework)
```

---

## Setup Local

### 1. Clonar e instalar dependências

```bash
git clone https://github.com/hugoprudente31/sistema.git
cd sistema
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp env.example .env
```

Preencha pelo menos `SESSION_SECRET` e um `DATABASE_URL` apontando pra
um Postgres (local ou o mesmo do Railway). Veja `env.example` pra lista
completa — Kommo, criptografia de segredos do painel e chaves dos apps
integrados (AdAnalyzer, captação de leads) são opcionais pra rodar
localmente.

### 3. Rodar localmente

```bash
npm run dev    # com hot-reload (nodemon)
# ou
npm start      # como em produção
```

No boot, `initDatabase()` cria/atualiza o schema inteiro no Postgres
configurado (idempotente — seguro rodar toda vez).

Acesse: **http://localhost:3000**

---

## Testes

```bash
npm test                 # suíte principal — mockada, rápida, sem rede (~15s)
npm run test:integration # contra um Postgres real e isolado — ver detalhes abaixo
```

`npm test` cobre permissão por perfil/loja, validação de rotas e regras
de negócio via `pool`/`pool.connect` mockados — não toca em banco real,
roda em qualquer máquina sem configuração.

`npm run test:integration` roda contra um banco Postgres de verdade
(cria um banco isolado, `sistema_test`, no mesmo servidor apontado por
`TEST_DATABASE_URL` — nunca o banco de produção), com o schema real
criado pela mesma `initDatabase()` usada em produção. Existe pra pegar
bugs que só aparecem em constraints/triggers reais do banco (ex.:
tentar marcar dois agendamentos no mesmo horário/optometrista). Só
roda se `TEST_DATABASE_URL` estiver definida:

```bash
TEST_DATABASE_URL="postgresql://usuario:senha@host:porta/postgres" npm run test:integration
```

---

## Deploy (Railway)

1. Push pra `main` no GitHub — o Railway builda e sobe automaticamente.
2. Serviços do projeto: `sistema` (esta app) + `Postgres`.
3. Variáveis de ambiente configuradas direto no Railway (mesmas chaves
   de `env.example`, mais `DATABASE_URL` — injetada automaticamente
   pelo serviço Postgres).
4. Produção: https://sistema.oticastgt.com.br

---

## Variáveis de Ambiente

Ver `env.example` pra lista completa e comentada. As essenciais pra
rodar localmente:

| Variável | Descrição | Obrigatório |
|---|---|---|
| `DATABASE_URL` | Connection string do Postgres | **Sim** |
| `SESSION_SECRET` | Assina cookies de sessão; use valor aleatório com 32+ caracteres | **Sim** |
| `SESSION_TTL_HOURS` | Duração da sessão; padrão 12 horas | Não |
| `ALLOWED_ORIGINS` | Origens CORS separadas por vírgula | Não |
| `KOMMO_*` | Credenciais e configuração do bot/Kommo (ver `env.example`) | Só se for usar o Kommo |

Cada usuário entra com e-mail e senha individual (hash bcrypt). As
rotas internas em `/api/*` exigem cookie de sessão assinado — só
`/api/auth/login`, `/api/auth/logout` e `/api/public/*` ficam fora
dessa exigência. Perfil e loja são sempre validados no servidor;
esconder botão no navegador não é controle de segurança.

---

## Perfis e Permissões

7 perfis (`admin`, `atendimento central`, `gerente de loja`,
`comprador`, `consultor de vendas`/`vendedor`, `optometrista`), mais um
Super Admin exclusivo (identidade fixa, não atribuível pelo painel).
Cálculo de permissão centralizado em `buildPermissions()` — quem vê
todas as lojas, quem cria agendamento, quem mexe em OS/financeiro, etc.
A exceção Gonzaga/Santos (controle total de OS e financeiro pra
vendedores dessa loja) é intencional e vale só pra ela.

---

## Verificar saúde da API

```bash
curl http://localhost:3000/health
```
