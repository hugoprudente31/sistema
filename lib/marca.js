// Marca do sistema: logo da barra de navegação e ícone do app (PWA).
//
// O Super Admin envia as imagens pelo painel (Configurações > Logo do App e
// da Barra). O navegador já recorta e redimensiona o ícone nos tamanhos que
// o celular pede (192, 512, 512 "maskable" e 180 para iPhone), então aqui só
// validamos, guardamos no banco (tabela configuracoes_integracao) e servimos
// as imagens nos mesmos endereços que o app instalável já usa
// (/icons/icon-192.png etc.). Sem imagem personalizada, valem os arquivos
// padrão de public/icons.

const fs = require("fs");
const path = require("path");

const ICONES = {
  icon192: { arquivo: "icon-192.png", chave: "marca_icone_192", tamanho: 192 },
  icon512: { arquivo: "icon-512.png", chave: "marca_icone_512", tamanho: 512 },
  iconMaskable512: { arquivo: "icon-maskable-512.png", chave: "marca_icone_maskable_512", tamanho: 512 },
  appleTouch: { arquivo: "apple-touch-icon.png", chave: "marca_icone_apple", tamanho: 180 }
};
const CHAVE_LOGO_BARRA = "marca_logo_barra";
const CHAVE_VERSAO = "marca_versao";
// O corpo JSON da API aceita até 1 MB; deixamos folga para o restante do JSON.
const TAMANHO_MAXIMO_DATA_URL = 950000;

const estado = { logoBarra: "", icones: {}, versao: 0 };

function decodificarDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ""));
  if (!m) return null;
  return { tipo: m[1].toLowerCase(), buffer: Buffer.from(m[2], "base64") };
}

function validarImagem(dataUrl, { somentePng = false } = {}) {
  const texto = String(dataUrl || "").trim();
  if (!texto) return "Selecione uma imagem.";
  if (texto.length > TAMANHO_MAXIMO_DATA_URL) return "A imagem deve ter no máximo aproximadamente 700 KB.";
  const img = decodificarDataUrl(texto);
  if (!img) return somentePng ? "O ícone precisa ser PNG." : "Use uma imagem PNG ou JPG válida.";
  if (somentePng && img.tipo !== "image/png") return "O ícone precisa ser PNG.";
  return null;
}

function resumo() {
  return {
    versao: estado.versao,
    temLogoBarra: Boolean(estado.logoBarra),
    temIconePersonalizado: Boolean(estado.icones.icon192)
  };
}

function criarMarca({ getConfigValor, setConfigValor, publicPath }) {
  const manifestoPadrao = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(publicPath, "manifest.webmanifest"), "utf8"));
    } catch (_error) {
      return null;
    }
  })();

  async function carregar() {
    estado.logoBarra = (await getConfigValor(CHAVE_LOGO_BARRA)) || "";
    for (const [nome, info] of Object.entries(ICONES)) {
      estado.icones[nome] = (await getConfigValor(info.chave)) || "";
    }
    estado.versao = Number(await getConfigValor(CHAVE_VERSAO)) || 0;
  }

  async function novaVersao(email) {
    estado.versao = Math.max(Date.now(), estado.versao + 1);
    await setConfigValor(CHAVE_VERSAO, String(estado.versao), { email });
  }

  async function salvarLogoBarra(dataUrl, email) {
    const erro = validarImagem(dataUrl);
    if (erro) return { ok: false, message: erro };
    estado.logoBarra = String(dataUrl).trim();
    await setConfigValor(CHAVE_LOGO_BARRA, estado.logoBarra, { email });
    await novaVersao(email);
    return { ok: true, message: "Logo da barra salvo." };
  }

  async function removerLogoBarra(email) {
    estado.logoBarra = "";
    await setConfigValor(CHAVE_LOGO_BARRA, "", { email });
    await novaVersao(email);
    return { ok: true, message: "Logo da barra voltou ao padrão." };
  }

  async function salvarIcone(nome, dataUrl, email) {
    if (!ICONES[nome]) return { ok: false, message: "Tamanho de ícone inválido." };
    const erro = validarImagem(dataUrl, { somentePng: true });
    if (erro) return { ok: false, message: erro };
    estado.icones[nome] = String(dataUrl).trim();
    await setConfigValor(ICONES[nome].chave, estado.icones[nome], { email });
    await novaVersao(email);
    return { ok: true, message: "Ícone salvo." };
  }

  async function removerIcones(email) {
    for (const [nome, info] of Object.entries(ICONES)) {
      estado.icones[nome] = "";
      await setConfigValor(info.chave, "", { email });
    }
    await novaVersao(email);
    return { ok: true, message: "Ícone do app voltou ao padrão." };
  }

  function enviarImagem(res, dataUrl) {
    const img = decodificarDataUrl(dataUrl);
    if (!img) return false;
    res.setHeader("Content-Type", img.tipo);
    // A URL leva ?v=<versão>, então o navegador pode revalidar sem custo.
    res.setHeader("Cache-Control", "no-cache");
    res.end(img.buffer);
    return true;
  }

  // Middleware registrado ANTES do express.static: troca os ícones padrão e o
  // manifesto quando há imagem personalizada.
  function middleware(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    if (req.path === "/marca/logo-barra") {
      if (estado.logoBarra && enviarImagem(res, estado.logoBarra)) return;
      return res.status(404).end();
    }

    if (req.path.startsWith("/icons/")) {
      const arquivo = req.path.slice("/icons/".length);
      const nome = Object.keys(ICONES).find((k) => ICONES[k].arquivo === arquivo);
      if (nome && estado.icones[nome] && enviarImagem(res, estado.icones[nome])) return;
      return next();
    }

    if (req.path === "/manifest.webmanifest" && manifestoPadrao && estado.versao) {
      const manifesto = {
        ...manifestoPadrao,
        icons: (manifestoPadrao.icons || []).map((icone) => ({
          ...icone,
          src: `${icone.src}?v=${estado.versao}`
        }))
      };
      res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      return res.send(JSON.stringify(manifesto));
    }

    next();
  }

  return {
    carregar,
    middleware,
    resumo,
    salvarLogoBarra,
    removerLogoBarra,
    salvarIcone,
    removerIcones,
    nomesIcones: Object.keys(ICONES)
  };
}

module.exports = { criarMarca, ICONES, validarImagem };
