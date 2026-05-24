// Bot Messages — Sistema Óticas Target
// Todas as mensagens do bot em um único lugar.
// Funções puras: recebem dados, retornam string ou string[].

// Endereços configuráveis via variáveis de ambiente
const LOJAS_INFO = [
  {
    nome:     "Gonzaga & Santos",
    endereco: process.env.ENDERECO_GONZAGA     || "Av. Ana Costa, 267 — Gonzaga, Santos/SP",
    horario:  process.env.HORARIO_GONZAGA      || "Seg a Sex: 9h–18h | Sáb: 9h–17h",
  },
  {
    nome:     "Óticas TGT Enseada",
    endereco: process.env.ENDERECO_ENSEADA     || "Consulte-nos para o endereço atualizado",
    horario:  process.env.HORARIO_ENSEADA      || "Seg a Sex: 9h–18h | Sáb: 9h–17h",
  },
  {
    nome:     "Óticas TGT Pitangueiras",
    endereco: process.env.ENDERECO_PITANGUEIRAS || "Consulte-nos para o endereço atualizado",
    horario:  process.env.HORARIO_PITANGUEIRAS  || "Seg a Sex: 9h–18h | Sáb: 9h–17h",
  },
  {
    nome:     "Óticas Target - Ademar de Barros",
    endereco: process.env.ENDERECO_ADEMAR      || "Consulte-nos para o endereço atualizado",
    horario:  process.env.HORARIO_ADEMAR       || "Seg a Sex: 9h–18h | Sáb: 9h–17h",
  },
];

module.exports = {

  LOJAS_INFO,

  // ── Geral ────────────────────────────────────────────────────

  foraDoHorario: (nome) =>
    `Olá${nome ? `, ${nome}` : ""}! 🌙\n` +
    `Nosso horário de atendimento é das 8h às 20h.\n` +
    `Sua mensagem foi registrada e responderemos em breve!`,

  respostaInvalida: () =>
    `Desculpe, não entendi sua resposta. 😅\nPor favor, responda com o *número* da opção desejada.`,

  // ── Boas-vindas e menu principal ─────────────────────────────

  boasVindas: (nome) =>
    `Olá, *${nome || "visitante"}*! 👋 Seja bem-vindo(a) às *Óticas Target*! 👓\n\n` +
    `Estou aqui para te ajudar. O que você deseja hoje?\n\n` +
    `1️⃣ Informações\n` +
    `2️⃣ Agendamento de Teste de Visão Grátis\n` +
    `3️⃣ Orçamentos\n` +
    `4️⃣ Falar com um Atendente\n\n` +
    `Responda com o número da opção desejada. 😊`,

  menuPrincipal: () =>
    `O que você deseja? 😊\n\n` +
    `1️⃣ Informações\n` +
    `2️⃣ Agendamento de Teste de Visão Grátis\n` +
    `3️⃣ Orçamentos\n` +
    `4️⃣ Falar com um Atendente`,

  // ── Opção 1 — Informações ────────────────────────────────────

  infoMenu: () =>
    `Ótimo! Sobre o que você gostaria de saber? 📋\n\n` +
    `1️⃣ Endereço e horários de atendimento\n` +
    `2️⃣ Garantia e nota fiscal\n` +
    `3️⃣ Óculos de sol\n` +
    `4️⃣ Lentes e armações de grau\n` +
    `5️⃣ Óculos de grau pronto em até 1 hora\n` +
    `6️⃣ Promoções\n` +
    `7️⃣ Falar com um atendente`,

  infoEndereco: () => {
    const linhas = LOJAS_INFO.map((l, i) =>
      `🏪 *${l.nome}*\nEndereço: ${l.endereco}\nHorário: ${l.horario}`
    ).join("\n\n");
    return `📍 *Nossas lojas:*\n\n${linhas}\n\n` +
      `Tem mais alguma dúvida?\n1️⃣ Voltar ao menu principal\n2️⃣ Falar com atendente`;
  },

  infoGarantia: () =>
    `✅ *Garantia e Nota Fiscal nas Óticas Target:*\n\n` +
    `🛡️ Garantia de 1 ano para defeitos de fabricação em armações e lentes.\n` +
    `🧾 Nota fiscal emitida em todas as compras.\n` +
    `🔧 Assistência técnica gratuita durante o período de garantia.\n\n` +
    `Tem mais alguma dúvida?\n1️⃣ Voltar ao menu\n2️⃣ Falar com atendente`,

  infoOculosSol: () =>
    `😎 *Óculos de Sol nas Óticas Target:*\n\n` +
    `Trabalhamos com as melhores marcas nacionais e importadas.\n` +
    `Temos modelos para todos os estilos e faixas de preço.\n` +
    `Lentes com proteção UV400 em todos os modelos.\n\n` +
    `Venha experimentar! Que tal agendar uma visita?\n` +
    `1️⃣ Agendar visita\n2️⃣ Voltar ao menu\n3️⃣ Falar com atendente`,

  infoLentes: () =>
    `👓 *Lentes e Armações nas Óticas Target:*\n\n` +
    `Centenas de modelos de armações para todos os gostos.\n` +
    `Lentes simples, antirreflexo, fotossensíveis e de contato.\n` +
    `Trabalhamos com os principais laboratórios do mercado.\n\n` +
    `1️⃣ Solicitar orçamento\n2️⃣ Agendar teste de visão grátis\n3️⃣ Voltar ao menu\n4️⃣ Falar com atendente`,

  infoOculosRapido: () =>
    `⚡ *Óculos de Grau Prontos em até 1 Hora!*\n\n` +
    `Sim, isso mesmo! Para graus simples, entregamos na hora.\n` +
    `Sem espera, sem demora. Saia da loja já enxergando melhor! 🎉\n\n` +
    `Quer saber se seu grau se enquadra? Agende um teste agora!\n` +
    `1️⃣ Agendar teste de visão grátis\n2️⃣ Voltar ao menu\n3️⃣ Falar com atendente`,

  infoPromocoes: () =>
    `🎁 *Promoções das Óticas Target:*\n\n` +
    `Para saber as promoções atuais, nosso atendente vai te passar\n` +
    `as melhores ofertas em tempo real! 💰\n\n` +
    `1️⃣ Falar com atendente sobre promoções\n2️⃣ Voltar ao menu`,

  // ── Opção 2 — Agendamento ────────────────────────────────────

  agendamentoTipo: () =>
    `📅 Ótimo! Vamos agendar seu teste de visão gratuito!\n\n` +
    `Como prefere agendar?\n\n` +
    `1️⃣ Agendamento para 1 pessoa\n` +
    `2️⃣ Agendamento para grupo (3 ou mais pessoas)`,

  agendamentoEscolhaLoja: (lojas) => {
    const lista = lojas.map((l, i) => `${i + 1}️⃣ ${l}`).join("\n");
    return `Em qual loja você prefere ser atendido(a)? 🏪\n\n${lista}`;
  },

  agendamentoEscolhaData: (loja) =>
    `Ótimo! Você escolheu *${loja}*. 👍\n\n` +
    `Qual data você prefere? 📆\n` +
    `_(informe no formato DD/MM/AAAA)_`,

  agendamentoDataInvalida: () =>
    `⚠️ Data inválida. Por favor, informe no formato *DD/MM/AAAA*.\nExemplo: 25/06/2026`,

  agendamentoDataPassada: () =>
    `⚠️ Essa data já passou! Por favor, escolha uma data futura. 📆`,

  agendamentoEscolhaHorario: (loja, data, horarios) => {
    const lista = horarios.map((h, i) => `${i + 1}️⃣ ${h}`).join("\n");
    return `Horários disponíveis em *${loja}* no dia *${data}*:\n\n${lista}\n\nQual você prefere?`;
  },

  agendamentoSemVagas: (data) =>
    `😔 Não há vagas disponíveis no dia *${data}*.\n\n` +
    `Por favor, escolha outra data.\n_(informe no formato DD/MM/AAAA)_`,

  agendamentoConfirmar: (nome, loja, data, horario) =>
    `Perfeito! Confirme seu agendamento:\n\n` +
    `👤 Nome: *${nome}*\n` +
    `🏪 Loja: *${loja}*\n` +
    `📅 Data: *${data}*\n` +
    `⏰ Horário: *${horario}*\n\n` +
    `Confirmar? Responda *SIM* ou *NÃO*.`,

  agendamentoConfirmado: (data, horario, loja) =>
    `✅ *Agendamento confirmado!*\n\n` +
    `Nos vemos em *${data}* às *${horario}* na loja *${loja}*! 🎉\n\n` +
    `Qualquer dúvida, estamos aqui. ⚠️ Em caso de imprevisto, nos avise com antecedência.`,

  agendamentoGrupo: () =>
    `👥 *Agendamento em grupo!*\n\n` +
    `Para grupos de 3 ou mais pessoas, precisamos verificar\n` +
    `disponibilidade especial com nossa equipe.\n\n` +
    `Por favor, informe:\n` +
    `• Quantas pessoas?\n` +
    `• Data e horário preferidos?\n` +
    `• Qual loja?\n\n` +
    `Um atendente entrará em contato para confirmar. 📞`,

  // ── Opção 3 — Orçamentos ─────────────────────────────────────

  orcamentoMenu: () =>
    `💰 Que tipo de orçamento você precisa?\n\n` +
    `1️⃣ Passagem de lentes (trocar lentes em armação existente)\n` +
    `2️⃣ Lentes + armação (conjunto completo)\n` +
    `3️⃣ Cobrir orçamento de outra ótica`,

  orcamentoPassagem: () =>
    `🔄 *Passagem de Lentes*\n\n` +
    `Para te passar o melhor orçamento, preciso de alguns dados:\n\n` +
    `1. Você tem a receita médica atualizada? _(SIM ou NÃO)_\n` +
    `2. Qual é o tipo de lente desejado?\n` +
    `   • Simples\n` +
    `   • Antirreflexo\n` +
    `   • Fotossensível (muda de cor)\n` +
    `   • Não sei, preciso de orientação\n\n` +
    `Por favor, responda as duas perguntas. 😊`,

  orcamentoConjunto: () =>
    `👓 *Orçamento Completo (Lentes + Armação)*\n\n` +
    `Para te ajudar melhor:\n\n` +
    `1. Você já tem receita médica? _(SIM ou NÃO)_\n` +
    `2. Qual faixa de valor você tem em mente?\n` +
    `   • Até R$200\n` +
    `   • R$200 a R$500\n` +
    `   • R$500 a R$1.000\n` +
    `   • Acima de R$1.000\n` +
    `   • Ainda não sei\n\n` +
    `Responda e um atendente preparará as melhores opções! 😊`,

  orcamentoCobertura: () =>
    `🤝 *Cobrimos Orçamentos!*\n\n` +
    `Manda a foto ou o valor do orçamento que você recebeu\n` +
    `e vamos ver o que podemos fazer por você! 💪\n\n` +
    `Envie a imagem ou o valor agora.`,

  // ── Opção 4 — Transferência para humano ─────────────────────

  transferindoParaHumano: () =>
    `👋 Claro! Estou transferindo você para um de nossos atendentes.\n\n` +
    `Em breve alguém da nossa equipe vai falar com você! 😊\n` +
    `Horário de atendimento: Seg a Sex 9h–18h | Sáb 9h–17h`,

  // Nota interna para o atendente (não enviada ao cliente)
  notaParaAtendente: (state) => {
    const partes = [
      `📋 RESUMO DO ATENDIMENTO BOT`,
      `Nome: ${state.nome || "Desconhecido"}`,
      `Etapa em que estava: ${state.etapa}`,
      state.loja ? `Loja de interesse: ${state.loja}` : null,
      state.dados_agendamento?.data    ? `Data desejada: ${state.dados_agendamento.data}`    : null,
      state.dados_agendamento?.horario ? `Horário desejado: ${state.dados_agendamento.horario}` : null,
    ].filter(Boolean).join("\n");
    return partes;
  },

  // ── Fechamento ───────────────────────────────────────────────

  fechadoGanho: (nome) =>
    `🎊 Parabéns pela sua escolha${nome ? `, *${nome}*` : ""}!\n\n` +
    `Foi um prazer atender você nas Óticas Target! 😊\n` +
    `Qualquer dúvida ou necessidade, estaremos sempre aqui.\n\n` +
    `Não se esqueça: sua garantia está registrada conosco. ✅`,

  // ── Lembrete de agendamento (24h antes) ─────────────────────

  lembrete24h: (nome, data, horario, loja) =>
    `⏰ Lembrete: *${nome || "Olá"}*, seu teste de visão está agendado para amanhã!\n\n` +
    `📅 Data: *${data}*\n` +
    `⏰ Horário: *${horario}*\n` +
    `🏪 Loja: *${loja}*\n\n` +
    `Confirma sua presença? Responda *SIM* ou *NÃO*.`,

  lembreteConfirmado: () =>
    `✅ Presença confirmada! Te esperamos amanhã. 😊`,

  lembreteCancelado: () =>
    `😔 Tudo bem! Quer remarcar para outra data?\n\n` +
    `1️⃣ Sim, quero remarcar\n2️⃣ Não, pode cancelar`,

  // ── Recuperação de lead frio ─────────────────────────────────

  recuperacao: (nome) =>
    `Oi${nome ? `, *${nome}*` : ""}! 👋 Tudo bem?\n\n` +
    `Notamos que você se interessou pelos serviços das *Óticas Target*\n` +
    `mas ainda não finalizamos seu atendimento. 😊\n\n` +
    `Sabia que muitos dos nossos clientes ficam surpresos com\n` +
    `os preços e a qualidade que oferecemos?\n\n` +
    `Que tal darmos uma segunda chance? Posso te ajudar agora! 💪\n\n` +
    `1️⃣ Quero agendar meu teste de visão grátis\n` +
    `2️⃣ Quero ver orçamentos\n` +
    `3️⃣ Prefiro falar com atendente`,
};
