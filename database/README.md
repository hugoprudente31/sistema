# Operação do PostgreSQL

## Migrações

As migrações ficam em `database/migrations` e são executadas por
`lib/migrations.js` depois da criação compatível do schema legado. Cada migração
tem um identificador imutável e é registrada em `schema_migrations`.

Regras:

1. nunca alterar uma migração já aplicada;
2. criar um novo arquivo numerado para cada mudança;
3. usar transação e comandos idempotentes sempre que possível;
4. validar no PostgreSQL temporário do CI antes do deploy;
5. evitar exclusão ou conversão destrutiva sem backup e ensaio de restauração.

## Saúde operacional

O Super Admin pode consultar `GET /api/admin/database/health`. A resposta mostra
uso do pool, tamanho do banco, estimativa de linhas e linhas mortas, migrações,
execuções recentes das automações e uma prévia da política de retenção.

## Retenção

A retenção nasce desativada. `DATABASE_RETENTION_ENABLED=true` permite remover,
em lotes de até 10.000 linhas por dia, apenas logs e execuções antigas. Mensagens
do CRM exigem também `DATABASE_CRM_RETENTION_ENABLED=true`.

Históricos comerciais, agendamentos, clientes, faturamentos e auditoria de
alterações nunca são apagados por essa rotina.

## Backup e restauração

Antes de migração destrutiva:

1. gerar snapshot/backup do PostgreSQL no provedor;
2. restaurar em ambiente separado;
3. executar `npm run test:integration` contra o banco restaurado;
4. conferir contagens de agendamentos, clientes, negociações e usuários;
5. só então autorizar a migração de produção.

O objetivo operacional é manter um backup diário e realizar um teste de
restauração periódico. O teste de restauração é indispensável: backup não
testado não é garantia de recuperação.
