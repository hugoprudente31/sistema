// Bot Messages - SalesBot Kommo Oticas TGT.

const LINK_TESTE_VISAO = process.env.LINK_TESTE_VISAO || "https://testedevisao.oticastgt.com.br/home";

const LOJAS_INFO = [
  {
    prefix: "gon",
    nome: "Gonzaga & Santos",
    titulo: "Óticas TGT - Gonzaga / Santos",
    whatsapp: "(13) 99645-3111",
    horario: "Agendamentos: Seg–Sex 10h às 18h | Sábado 10h às 16h | Domingo Fechado",
  },
  {
    prefix: "ens",
    nome: "Óticas TGT Enseada",
    titulo: "Óticas TGT - Enseada",
    whatsapp: "(13) 99721-4862",
    horario: "Agendamentos: Seg–Sex 10h às 18h | Sábado 10h às 16h | Domingo Fechado",
  },
  {
    prefix: "pit",
    nome: "Óticas TGT Pitangueiras",
    titulo: "Óticas TGT - Pitangueiras",
    whatsapp: "(13) 99704-0234",
    horario: "Agendamentos: Seg–Sex 10h às 18h | Sábado 10h às 16h | Domingo Fechado",
  },
  {
    prefix: "tgt",
    nome: "Óticas Target - Ademar de Barros",
    titulo: "Óticas TGT - Santo Antonio / Target",
    whatsapp: "(13) 99785-6493",
    horario: "Agendamentos: Seg–Sex 10h às 18h | Sábado 10h às 16h | Domingo Fechado",
  },
];

function storeByPrefix(prefix) {
  return LOJAS_INFO.find((loja) => loja.prefix === prefix) || LOJAS_INFO[0];
}

function menuPrincipal(loja = LOJAS_INFO[0]) {
  return `Olá! Seja bem-vindo(a) à ${loja.titulo}! 😊\n\n` +
    `É um prazer ter você aqui! Como podemos te ajudar hoje?\n\n` +
    `Escolha uma das opções abaixo:\n\n` +
    `1️⃣ Informações\n` +
    `2️⃣ Teste de Visão Grátis\n` +
    `3️⃣ Orçamento\n` +
    `4️⃣ Trabalhe Conosco\n` +
    `5️⃣ Pós Venda\n\n` +
    `Digite o número da opção desejada. 👓`;
}

module.exports = {
  LINK_TESTE_VISAO,
  LOJAS_INFO,
  storeByPrefix,

  respostaInvalida: () =>
    `Desculpe, não entendi sua resposta. 😅\nPor favor, responda com o número da opção desejada.`,

  menuPrincipal,
  boasVindas: (_nome, loja) => menuPrincipal(loja),

  infoMenu: () =>
    `Ótimo! Sobre o que você gostaria de saber mais? 😊\n\n` +
    `1️⃣ Lentes e Armações\n` +
    `2️⃣ Endereço e Horário de Funcionamento\n` +
    `3️⃣ Promoções\n` +
    `4️⃣ Falar com um Especialista\n\n` +
    `Digite o número da sua escolha:`,

  infoLentes: () =>
    `Temos uma linha completa de lentes e armações para todos os gostos e necessidades! 😊\n\n` +
    `Nossas lentes incluem: lentes de grau simples, bifocais, progressivas, lentes de contato, anti-reflexo, fotossensíveis e muito mais!\n\n` +
    `Nossas armações vão desde modelos clássicos até as últimas tendências de moda.\n\n` +
    `Um de nossos especialistas vai adorar te ajudar a encontrar a combinação perfeita para você! 🤩\n\n` +
    `Posso te conectar com um especialista agora? Responda SIM ou NÃO.`,

  infoEndereco: (loja) =>
    `📍 ${loja.titulo}\n\n` +
    `⏰ Horário de Funcionamento:\n${loja.horario}\n\n` +
    `📱 WhatsApp: ${loja.whatsapp}\n\n` +
    `Precisa de mais alguma informação? Responda SIM para falar com um especialista ou NÃO para voltar ao menu.`,

  infoPromocoes: () =>
    `Temos promoções incríveis esperando por você! 🎉\n\n` +
    `Para saber as promoções exclusivas e atuais da nossa loja, nosso especialista vai te passar todos os detalhes fresquinhos!\n\n` +
    `Posso te conectar agora? Responda SIM ou NÃO.`,

  transferindoParaHumano: () =>
    `Perfeito! Vou te conectar agora com um de nossos especialistas. 😊\n\n` +
    `Aguarde um momento, em breve alguém da nossa equipe estará com você!`,

  testeVisao: (loja) =>
    `Que ótima escolha! Nosso Teste de Visão é 100% Grátis e sem compromisso! 👁️✨\n\n` +
    `Para agendar, é super simples:\n\n` +
    `1️⃣ Clique no link abaixo\n` +
    `2️⃣ Escolha a loja ${loja.nome}\n` +
    `3️⃣ Selecione o dia e horário de sua preferência\n` +
    `4️⃣ Confirme o agendamento\n\n` +
    `🔗 ${LINK_TESTE_VISAO}\n\n` +
    `Após agendar, responda aqui com CONFIRMADO para finalizarmos seu atendimento! 😊`,

  testeConfirmado: (loja) =>
    `✅ Perfeito! Seu interesse no Teste de Visão Grátis foi registrado para ${loja.titulo}.\n\n` +
    `Se já concluiu o agendamento pelo link, nossa equipe acompanhará pelo sistema. Qualquer dúvida, estamos por aqui.`,

  orcamento: () =>
    `Olá! Ficamos felizes em preparar um orçamento especial para você! 😊\n\n` +
    `Para agilizar seu atendimento, por favor envie sua receita (foto ou arquivo) aqui mesmo pelo WhatsApp.\n\n` +
    `📋 Estamos com uma grande demanda de atendimentos no momento, mas fique tranquilo(a)! Em menos de 5 minutos um de nossos especialistas estará com você. ⏱️\n\n` +
    `Obrigado pela sua paciência! 🙏`,

  trabalheConosco: () =>
    `Que incrível! Adoramos receber talentos que queiram fazer parte da nossa família Óticas TGT! 😊🤝\n\n` +
    `Para darmos continuidade ao seu processo, por favor nos envie:\n\n` +
    `📄 Seu currículo (em PDF ou foto)\n` +
    `💼 O cargo que você está buscando\n\n` +
    `Nossa equipe vai analisar com carinho e entrar em contato em breve! 🌟`,

  posVendaMenu: () =>
    `Olá! Como podemos te ajudar com seu pós-venda? 😊\n\n` +
    `Escolha uma das opções abaixo:\n\n` +
    `1️⃣ Nota Fiscal\n` +
    `2️⃣ Garantia\n` +
    `3️⃣ Reembolso\n` +
    `4️⃣ Falar com um Especialista\n\n` +
    `Digite o número da sua escolha:`,

  posVendaNotaFiscal: () =>
    `Entendido! Vamos resolver a questão da sua nota fiscal rapidinho! 🧾\n\n` +
    `Um de nossos especialistas vai te atender agora para verificar e enviar sua nota fiscal. Aguarde um momento! 😊`,

  posVendaGarantia: () =>
    `Entendido! Vamos verificar a garantia do seu produto! 🛡️\n\n` +
    `Nosso especialista vai te atender agora com todas as informações sobre a garantia. Aguarde um momento! 😊`,

  posVendaReembolso: () =>
    `Entendido! Vamos tratar o seu reembolso com toda a atenção que você merece! 💙\n\n` +
    `Um especialista vai te atender agora para resolver isso da melhor forma possível. Aguarde um momento! 😊`,

  posVendaEspecialista: () =>
    `Perfeito! Vou te conectar agora com um de nossos especialistas de pós-venda. 😊\n\n` +
    `Aguarde um momento, em breve alguém da nossa equipe estará com você!`,

  foraDoHorario: (nome) =>
    `Olá${nome ? `, ${nome}` : ""}! 🌙\nSua mensagem foi registrada e responderemos em breve!`,

  foraDoHorarioHumano: (loja = "") =>
    `Sua mensagem foi registrada!\n\nNossa equipe retornará assim que estiver disponível.${loja ? `\nLoja: ${loja}` : ""}`,

  lembrete24h: (nome, data, horario, loja) =>
    `⏰ Lembrete: ${nome || "olá"}, seu teste de visão está agendado para amanhã!\n\n` +
    `📅 Data: ${data}\n` +
    `⏰ Horário: ${horario}\n` +
    `🏪 Loja: ${loja}\n\n` +
    `Confirma sua presença? Responda SIM ou NÃO.`,

  lembreteConfirmado: () =>
    `✅ Presença confirmada! Te esperamos amanhã. 😊`,

  lembreteCancelado: () =>
    `Tudo bem. Nossa equipe vai acompanhar seu retorno para remarcar, se necessário.`,

  recuperacao: (nome) =>
    `Oi${nome ? `, ${nome}` : ""}! Tudo bem?\n\n` +
    `Notamos que você se interessou pelos serviços das Óticas TGT, mas ainda não finalizamos seu atendimento.\n\n` +
    `Posso te ajudar agora?\n\n` +
    `1️⃣ Teste de Visão Grátis\n` +
    `2️⃣ Orçamento\n` +
    `3️⃣ Falar com especialista`,

  propostaSemCompra: (nome, loja) => {
    var primeiro = nome ? nome.trim().split(" ")[0] : "";
    return `Olá${primeiro ? ", " + primeiro : ""}! 😊\n\n` +
      `Foi muito bom te receber${loja ? " na " + loja : ""}!\n\n` +
      `Queremos garantir que você encontre a combinação perfeita de lentes e armações. ` +
      `Temos uma proposta especial preparada para você!\n\n` +
      `Posso te enviar agora?\n\n` +
      `1️⃣ Sim, quero ver a proposta\n` +
      `2️⃣ Prefiro em outro momento`;
  },

  notaParaAtendente: (state) => [
    "RESUMO DO ATENDIMENTO BOT",
    `Nome: ${state.nome || "Desconhecido"}`,
    `Loja de interesse: ${state.loja || "Não identificada"}`,
    `Etapa: ${state.etapa}`,
    state.ultimo_topico ? `Tópico: ${state.ultimo_topico}` : null,
  ].filter(Boolean).join("\n"),
};
