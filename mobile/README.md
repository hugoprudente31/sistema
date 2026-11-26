# TGT Agenda: aplicativo Android e iPhone

Esta pasta transforma o sistema de agendamentos em aplicativo de celular usando
[Capacitor](https://capacitorjs.com). O app é uma "casca" nativa que abre o
sistema oficial (`https://sistema.oticastgt.com.br`). Por isso:

- Toda correção publicada no Railway aparece no app na hora, sem precisar
  mandar versão nova para as lojas.
- Login, agenda, relatórios e permissões funcionam igual ao navegador.
- Sem internet, o app mostra uma tela "Sem conexão" com botão para tentar de novo.

## Três formas de usar

### 1. Instalar direto pelo navegador (grátis, já funciona)
- **Android (Chrome):** abra o sistema, toque no menu ⋮ e em "Instalar app"
  ou "Adicionar à tela inicial".
- **iPhone (Safari):** abra o sistema, toque em Compartilhar (quadrado com
  seta) e em "Adicionar à Tela de Início".

O ícone "TGT Agenda" aparece na tela do celular e abre em tela cheia, sem a
barra do navegador.

### 2. APK Android para a equipe (grátis)
O GitHub gera o arquivo do app automaticamente (workflow
`.github/workflows/android-apk.yml`). Para baixar:
1. GitHub → aba **Actions** → "App Android (APK de teste)".
2. Abra a execução mais recente → em **Artifacts**, baixe `tgt-agenda-android-apk`.
3. Envie o `app-debug.apk` para o celular e instale (o Android pede para
   permitir "instalar apps de fontes desconhecidas").

Para gerar sob demanda: Actions → "App Android (APK de teste)" → **Run workflow**.

### 3. Publicar nas lojas (Google Play e App Store)
| Loja | O que precisa | Custo |
|---|---|---|
| Google Play | Conta Google Play Console | US$ 25 (uma vez) |
| App Store (iPhone) | Conta Apple Developer + um Mac com Xcode para enviar | US$ 99 por ano |

Passos técnicos:
- **Android:** criar uma chave de assinatura (keystore), gerar o pacote de
  produção (`./gradlew bundleRelease` em `mobile/android`) e enviar o `.aab`
  no Play Console.
- **iPhone:** num Mac, `npm ci && npx cap sync ios && npx cap open ios`, depois
  no Xcode escolher a conta Apple, "Product → Archive" e enviar pelo
  App Store Connect.

Atenção: a Apple às vezes recusa apps que só abrem um site. Como o sistema é de
uso interno (login de funcionários), a alternativa recomendada no iPhone é
distribuir pelo **Apple Business Manager / app privado** ou usar a instalação
pelo Safari (opção 1).

## Comandos úteis (para desenvolvedores)
```bash
cd mobile
npm ci
npx cap sync            # copia config e www para android/ e ios/
npx cap open android    # abre no Android Studio
npx cap open ios        # abre no Xcode (somente Mac)
npm run icons           # regenera ícones a partir de assets/icon-only.png
```

Identificador do app: `br.com.oticastgt.agenda`. Endereço aberto pelo app:
`server.url` em `capacitor.config.json`.
