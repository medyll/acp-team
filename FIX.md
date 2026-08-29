# FIX — acp-team

Trois correctifs, par ordre de priorité. P0 est un bug fonctionnel, P1 et P2 sont
des réductions de consommation du contexte de l'appelant.

Base : `main` @ `ff6ca7d`.

---

## P0 — Les agents ACP ne trouvent pas leurs skills (cwd)

### Symptôme

Un agent délégué via `agent_ask` / `agent_start` ne trouve pas les skills du
projet et se comporte comme s'il tournait ailleurs. Touche `kimi` et `opencode`.
`codex` n'est pas affecté.

### Cause

`src/agents/acp/acp-client.js:62` — le process agent est spawné sans option `cwd` :

```js
this.proc = spawn(this.command, this.args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: this.shell,
  windowsHide: true
});
```

Le process hérite donc du cwd du serveur MCP (`process.cwd()` du bridge), pas du
cwd de la tâche. Le cwd demandé n'est transmis qu'ensuite, en paramètre du
`session/new` (`src/agents/acp/acp-client.js:207`). Un CLI qui découvre ses
skills sur disque relativement au cwd de son process cherche au mauvais endroit.

Aggravant : le process est unique et partagé entre tous les cwd. Voir le
commentaire d'en-tête `src/agents/acp/acp-adapter.js:5` — *"One long-lived
process backs every session"*. Le client est instancié une seule fois dans
`src/agents/registry.js` (`new KimiAcpClient(...)`, `new OpenCodeAcpClient(...)`)
et réutilisé pour tous les projets. Même en ajoutant `cwd` au spawn, un seul
process ne peut pas être ancré à plusieurs cwd à la fois.

Pourquoi codex passe : `src/agents/codex/codex-adapter.js:80` spawne un process
par tour avec `{ cwd, stdio }`. Le cwd est correct.

**Note :** `env` n'est pas un problème. `spawn` hérite de `process.env` quand
l'option `env` est omise. Ne rien changer là-dessus.

### Correctif attendu

1. `AcpClient` accepte un `cwd` au constructeur et le passe à `spawn`.
2. L'adaptateur ACP maintient un **pool de clients indexé par cwd** au lieu d'un
   client unique. Un cwd = un process = un ancrage disque correct.
3. Le registre passe une **factory** au lieu d'une instance, pour que
   l'adaptateur puisse créer un client par cwd.

### Points à ne pas casser

- **Injection en test.** `src/agents/kimi/kimi-adapter.js:10` et l'équivalent
  opencode acceptent aujourd'hui `client` injecté (`client ?? new KimiAcpClient`).
  Les tests s'appuient dessus (`src/agents/kimi/kimi-adapter.queue.test.js`,
  `src/agents/opencode/opencode-adapter.test.js`). Garder une porte d'injection :
  soit un `createClient` injectable, soit un `client` unique qui court-circuite le
  pool. Ne pas casser la signature côté tests sans les adapter.
- **`cancel(sessionId)`** — `src/agents/acp/acp-adapter.js:113`. Aujourd'hui il
  n'y a qu'un client, donc pas d'ambiguïté. Avec un pool il faut router vers le
  bon client : maintenir une map `sessionId -> client`, alimentée dans
  `resolveSession()` (`src/agents/acp/acp-adapter.js:25`).
- **`stop()`** — `src/agents/acp/acp-adapter.js:117`. Doit arrêter **tous** les
  clients du pool, pas un seul. Appelé par `registry.stopAll()` puis par le
  shutdown SIGINT/SIGTERM de `src/mcp-server.js:51`.
- **`status()`** — `src/agents/acp/acp-adapter.js:45`. Doit agréger les sessions
  de tous les clients du pool. Le champ `sessions: [{ cwd, sessionId }]` doit
  rester au même format : c'est ce que rend le tool `agent_status`.
- **Sonde de `status()`** — `src/agents/acp/acp-adapter.js:49` crée une session
  jetable sur `process.cwd()` juste pour lire la liste des modèles. Avec un pool
  ça allume un process de plus sur un cwd arbitraire. Utiliser le cwd par défaut
  du bridge, ou mieux : ne pas sonder si `knownModels` peut être obtenu autrement.
- **`knownModels`** — cache module-level aujourd'hui (`acp-adapter.js:22`).
  Reste partageable entre clients : c'est une propriété du CLI, pas du cwd.
- **Clés de la session queue** — `src/agents/acp/acp-adapter.js:65` utilise
  `sessionId ?? sessions.get(cwd) ?? cwd`. Les clés restent valides avec un pool
  puisque cwd et sessionId sont déjà distincts par projet. Ne pas y toucher sans
  raison.
- **Fuite de process.** Un pool sans borne ouvre un process par cwd visité et ne
  les ferme jamais. Prévoir au minimum une éviction : borne au nombre de clients
  vivants, ou fermeture d'un client inactif après un délai. Choisir une des deux,
  la documenter dans le code.

### Critères d'acceptation

- Un `agent_ask` sur `kimi` avec `cwd = /chemin/projet` produit un process kimi
  dont le cwd est `/chemin/projet`.
- Deux `agent_ask` sur deux cwd différents produisent deux process distincts,
  chacun ancré sur son cwd.
- Deux `agent_ask` sur le même cwd réutilisent le même process et la même session.
- `agent_status` liste les sessions de tous les cwd actifs.
- L'arrêt du bridge tue tous les process du pool. Aucun orphelin.
- `agent_cancel` sur une session d'un cwd n'affecte pas les autres cwd.

---

## P1 — `agent_ask` déverse tout le run dans le contexte de l'appelant

### Cause

`src/tools/shared.js:11` — `render()` concatène systématiquement le texte
complet, la liste intégrale des tool calls, et les pensées si demandées :

```js
export function render({ agent, result, includeThoughts }) {
  const body = result.text.trim() || `(${agent} returned no text)`;
  const tools = result.toolCalls.length
    ? `\n\n---\n${agent} tool calls:\n${result.toolCalls.map((t) => `- [${t.status}] ${t.title}`).join("\n")}`
    : "";
  ...
}
```

Un run de 40 tool calls = 40 lignes dans le contexte de l'appelant, en plus de la
réponse complète. Il n'existe aucun mode réduit.

### Correctif attendu

Ajouter à `agent_ask` un paramètre `return: "summary" | "full"`, défaut
`"summary"`.

- `full` : comportement actuel, inchangé.
- `summary` : le texte final, plus un **compte** de tool calls par statut au lieu
  de la liste, plus la ligne de métadonnées existante `(agent, session, stop)`.
  Jamais les thoughts.

`include_thoughts: true` doit continuer de fonctionner et implique `full`.

### Où le détail reste accessible

`agent_ask` est synchrone et ne retient rien. Deux options, au choix de
l'implémenteur — trancher et documenter :

- **A (minimale)** : `summary` ne perd que la liste des tool calls, qui est déjà
  visible en direct via les notifications de progression
  (`src/tools/shared.js:26`, `progressReporter`). Rien à stocker.
- **B (handle)** : `agent_ask` retient le résultat complet dans le run manager,
  comme le font déjà les runs supervisés (`src/runs/run-manager.js:166`), et rend
  un `run_id` que `run_show` peut relire.

A est suffisante si les notifications de progression couvrent le besoin. Ne pas
construire B sans raison.

### Critères d'acceptation

- `agent_ask` sans `return` ne rend plus la liste détaillée des tool calls.
- `return: "full"` rend exactement ce que la version actuelle rend.
- `include_thoughts: true` rend les thoughts.
- Les tests existants de `src/tools/agent-tools.test.js` passent, adaptés si le
  défaut change ce qu'ils asservissent.

---

## P2 — 29 tools MCP exposés en permanence

### Cause

`src/mcp-server.js:44-49` enregistre 29 tools à chaque démarrage. Leurs schémas
Zod et descriptions sont injectés dans chaque tour de l'appelant.

Répartition :

- 11 cœur : `agent_ask`, `agent_start`, `agent_fanout`, `agent_watch`,
  `agent_stop`, `agent_cancel`, `agent_list`, `agent_status`, `run_show`,
  `run_history`, `run_retry`
- 18 admin, rarement appelés : `config_*` (4), `usage_*` + `model_*` +
  `budget_check` (8), `ollama_*` (5), `system_doctor` (1)

`registerOllamaTools` est déjà conditionnel (`src/mcp-server.js:48`) — c'est le
précédent à suivre.

### Correctif attendu

Réduire la surface par défaut à ~11 tools. Deux approches, trancher :

- **A — registration conditionnelle.** Une variable d'env
  (`ACP_TEAM_TOOLS=core|full`, défaut `core`) qui n'enregistre les modules admin
  que sur demande. Simple, aligné sur l'existant ollama. Inconvénient : l'agent ne
  peut pas atteindre l'admin sans redémarrer le bridge.
- **B — dispatcher.** Un tool unique `acp_admin({ action, params })` qui route
  vers les handlers existants. Toujours disponible, un seul schéma dans le
  contexte. Inconvénient : perte de la validation Zod par action au niveau MCP,
  à réimplémenter dans le dispatcher.

Préférer B si l'admin doit rester joignable sans redémarrage, A sinon.

### Contrainte

Ne pas supprimer de fonctionnalité. Tout ce que fait aujourd'hui un tool admin
doit rester atteignable. Les tests de `src/tools/*.test.js` et
`src/mcp-tools.test.js` doivent continuer de couvrir les handlers.

---

## Ordre et découpage

P0 d'abord, seul, dans son propre commit — c'est le seul correctif de bug.
P1 ensuite. P2 en dernier, c'est mécanique.

Ne pas mélanger les trois dans un commit.

## Vérifications avant de rendre

```bash
pnpm test
```

```bash
pnpm lint
```

Ajouter des tests pour chaque critère d'acceptation ci-dessus. Les fichiers
existants à étendre :

- P0 : `src/agents/acp/acp-client.test.js`, `src/agents/kimi/kimi-adapter.queue.test.js`,
  `src/agents/opencode/opencode-adapter.test.js`
- P1 : `src/tools/agent-tools.test.js`
- P2 : `src/mcp-tools.test.js`

## Hors périmètre

Ne pas introduire de manifeste de skills, de registre de compétences ni de
routage par skill. Tant que P0 n'est pas corrigé, déclarer des skills ne sert à
rien puisque l'agent ne peut pas les lire sur disque. Sujet à rouvrir après.
