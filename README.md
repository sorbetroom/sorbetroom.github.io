# TWO OWT Office — versão coop para GitHub

O estúdio TWO OWT (o mesmo jogo do artefato no claude.ai) rodando fora do Claude, em qualquer hospedagem estática, com coop peer-to-peer entre quem abrir a página.

## Como funciona

O jogo só conversa com `window.claude.use(...)`. No claude.ai quem responde é a plataforma. Aqui, o `claude-p2p.js` (carregado antes do jogo) faz esse papel:

| No claude.ai | Aqui (P2P) |
|---|---|
| `room` — presença ao vivo | WebRTC via [Trystero](https://github.com/dmotz/trystero) (sinalização por relays Nostr públicos, sem servidor próprio) |
| `db` — documentos compartilhados | IndexedDB em cada navegador, sincronizado entre os peers (a escrita mais recente vence). Quem entra recebe o estado de quem já está |
| `assets` — capas, músicas, samples | Guardados no IndexedDB e passados de navegador para navegador. `/_blob/<id>` continua funcionando |
| `user` | ID estável por navegador e o apelido que você digita no jogo |
| `sample` — o Claude na sala | Não usado: nesta versão o Claude não está no escritório |

O `index.html` é o artefato com poucas trocas, todas feitas pelo `tools/sem-claude.py`:

- `<script src="claude-p2p.js"></script>` no `<head>`;
- o Claude fora do escritório: o robô não entra na sala (nem se o banco disser que ele voltou), somem os botões "Claude: na sala", "Chamar Claude" e "Uso do Claude", o `@claude` do chat, o monitor "CLAUDE" da parede e o item da roda de ações.

O resto do jogo (visitas dos NPCs, balada, produção, DJ, estante, arte, caça-níquel) segue igual; as falas dos NPCs que envolviam o Claude são puladas pelo próprio jogo.

## Publicar no GitHub Pages

1. Crie o repositório e suba estes arquivos (incluindo `.nojekyll` e a pasta `vendor/`).
2. Em **Settings → Pages**, escolha **Deploy from a branch**, branch `main`, pasta `/ (root)`.
3. Abra `https://<seu-usuario>.github.io/<repo>/`.

Para testar localmente: `python3 -m http.server` dentro da pasta e abra `http://localhost:8000` (abrir o arquivo direto com `file://` não funciona por causa do módulo).

## Salas e senha

- Todo mundo que abre a mesma URL cai na sala `estudio`.
- Sala própria: `…/index.html?sala=nome-da-sala`
- Sala com senha (a sinalização fica cifrada e só entra quem sabe): `…/index.html?sala=nome&senha=segredo`

Também dá para fixar no HTML, antes do `claude-p2p.js`:

```html
<script>window.TWOOWT_P2P_CONFIG = { room: 'minha-sala', password: 'segredo' }</script>
```

## O que saber

- **O estado mora nos navegadores.** Não há servidor. Se todo mundo sair, o próximo a entrar traz o estado que tinha salvo; quem chega depois sincroniza com ele.
- **Todos podem tudo.** No claude.ai as permissões vêm da plataforma; aqui é coop entre amigos. Use uma sala com senha se for público.
- **Arquivos enviados** (até 20 MB) vão para quem estiver na sala na hora e, depois, para quem pedir, desde que alguém que os tenha esteja online.
- **Duas abas do mesmo navegador** entram como duas pessoas (cada aba é um peer), mas compartilham o mesmo estado salvo.
- **Redes muito fechadas** (algumas empresariais/escolares) podem bloquear WebRTC sem um servidor TURN.

## Atualizar a partir do artefato

Quando o artefato mudar, salve o HTML novo (por exemplo `artefato.html`) e rode:

```sh
python3 tools/sem-claude.py artefato.html index.html
```

O script refaz todas as trocas e para com um aviso se algum trecho esperado tiver mudado no jogo. O shim (`claude-p2p.js`) não depende do código do jogo, só das APIs `room`, `db`, `user` e `assets`.

## Licenças

`vendor/trystero.min.mjs` é o Trystero 0.27.0 empacotado (MIT, ver `vendor/TRYSTERO-LICENSE`).
