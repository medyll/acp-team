# Audit de correction et de portabilité — acp-team

Date : 6 septembre 2026. Version examinée : `@medyll/acp-team@1.0.10`. Commit : `f9529a7d010bae4b0b7a702f04783cf89a03f32d`.

Le projet dispose d’une base exploitable : séparation des adaptateurs, tests unitaires, autorisations à durée limitée, journal des exécutions et contrôle de concurrence. Une réécriture complète ne se justifie pas. En revanche, certaines frontières de sécurité peuvent être contournées et plusieurs parcours Windows restent défectueux malgré une suite de tests verte.

**La portabilité n’est pas validée en l’état.** Les tests locaux passent sous Windows, mais un lancement de commande utilisé par l’installateur y échoue réellement. Linux et macOS demandent encore une validation d’intégration. Ce document propose les corrections ; l’audit n’a pas modifié le code de production.

Les références de fichiers et de lignes correspondent au commit ci-dessus. Les chemins relatifs cités dans le texte partent de la racine du dépôt, pour conserver leur sens après déplacement du projet.

## Vérifications réalisées et limites

| Vérification | Résultat |
|---|---|
| Environnement des reproductions | Windows x64, Node.js `v25.2.1` |
| `pnpm test` | **139 tests réussis**, 0 échec, 0 ignoré ; environ 5,45 secondes rapportées par Node |
| `pnpm lint` | Réussi, code de sortie 0 |
| Échange ACP avec un faux agent Node local | Une politique `deny` sélectionne une option `allow_once` lorsqu’aucun refus n’est proposé |
| Lancement réel `spawn('npm.cmd', ['--version'], { shell: false })` | Exception synchrone `EINVAL` sous Windows |
| Validation d’un plan d’installation fictif | Un plan portant sur un autre paquet et une désinstallation passe la validation |
| Adaptateur ACP avec client instrumenté | `options.mode` atteint le client après la sélection du mode ; une session du dossier A est acceptée avec un `cwd` B |
| Adaptateur Codex avec processus simulé | Construction de deux réglages `sandbox_mode` contradictoires, celui fourni par l’appelant placé en dernier |
| Inspection statique | Entrées MCP, autorisations, adaptateurs, lancement et arrêt des processus, configuration, journal, comptabilité, workflows CI/release |

Les reproductions n’ont installé ni désinstallé de paquet et n’ont confié aucune tâche à un agent réel. Les assertions concernant les adaptateurs instrumentés portent sur les appels et arguments construits par le bridge ; elles ne constituent pas un essai d’écriture avec une CLI réelle.

Cet audit n’a pas exécuté la suite sur Linux, macOS ou les versions Node 20/22/24. Il n’a pas vérifié les derniers résultats GitHub Actions, effectué un nouvel audit de vulnérabilités du registre npm, ni testé le paquet publié sur une machine vierge. Les chiffres et appréciations des anciens rapports ne valent donc pas validation de cette version.

## Priorités

P1 : correction à traiter avant de considérer les protections ou les parcours concernés comme fiables. P2 : fiabilité, portabilité ou couverture à renforcer. « Reproduit » précise le niveau d’observation, sans supposer le comportement d’un fournisseur non testé.

| ID | Priorité | Problème | Preuve |
|---|---|---|---|
| A01 | P1 | Les options libres peuvent modifier les permissions après autorisation | Appels ACP et arguments Codex reproduits |
| A02 | P1 | Un refus ACP peut devenir une autorisation | Échange stdio réel avec faux agent |
| A03 | P1 | Le dossier autorisé peut différer du dossier de la session ACP | Client instrumenté et chemin d’appel MCP |
| A04 | P1 | Le validateur d’installation ne garantit pas l’action ni le paquet annoncés | Plan incohérent accepté |
| A05 | P1 | Les installations npm/pnpm sous Windows lancent un `.cmd` sans interpréteur | `EINVAL` reproduit |
| A06 | P2 | Les configurations et la compaction du ledger ne protègent pas les écritures concurrentes | Analyse des opérations sur fichiers |
| A07 | P2 | L’arrêt quitte avant la vidange du journal et ne garantit pas l’arrêt des descendants | Analyse du cycle de vie ; sémantique Node documentée |
| A08 | P2 | Le transport ACP ne valide pas suffisamment ses messages ni leur taille | Analyse du parseur et des limites |
| A09 | P2 | `agent_ask` contourne le superviseur et son plafond de concurrence | Analyse du chemin d’appel |
| A10 | P2 | La CI ne démontre pas la portabilité annoncée | Workflows et scripts inspectés |

## A01 — Rendre les options de sécurité non modifiables par les options libres

Références : `src/tools/agent-tools.js:35`, `src/tools/agent-tools.js:73`, `src/agents/acp/acp-adapter.js:181`, `src/agents/codex/codex-adapter.js:66`.

Le bridge autorise un mode, puis transmet `input.options` sans filtrer les paramètres de sécurité. L’adaptateur ACP appelle `setConfigOption` après avoir configuré le mode. L’adaptateur Codex ajoute les valeurs de `options` après ses propres arguments de sandbox.

Reproduction ACP : une demande `mode: "plan", options: { mode: "auto" }` produit successivement une session en `plan`, puis `setConfigOption(session, "mode", "auto")`. Le bridge accepte donc un second canal de sélection du mode qui ne passe pas par `requiresAuthorization`.

Reproduction Codex : `mode: "plan", options: { sandbox_mode: "workspace-write" }` construit notamment :

```text
-c sandbox_mode="read-only" ... -c sandbox_mode="workspace-write"
```

L’ordre et l’absence de rejet sont confirmés. L’effet final de ces arguments sur une CLI Codex réelle n’a pas été exécuté pendant cet audit.

**Correction proposée :** définir une liste explicite de réglages de modèle autorisés pour chaque adaptateur ; réserver les clés de mode, sandbox, approbation, racines accessibles, commandes et configuration d’outils au bridge. Refuser les options interdites avant de consommer une autorisation ou de démarrer un processus. Garder une vérification dans l’adaptateur pour protéger aussi les appels internes.

Critère d’acceptation : les chemins `agent_ask`, `agent_start` et `run_retry` refusent ces options sans créer de session ni consommer de jeton. Une option de modèle légitime reste utilisable. Aucun argument contradictoire ne sort du bridge.

## A02 — Ne jamais choisir une option d’autorisation pour satisfaire un refus

Référence : `src/agents/acp/acp-client.js:149`, notamment la sélection à la ligne 158.

Après avoir cherché un refus, le code utilise `?? options[0]`. Si l’agent ne fournit que des options d’autorisation, le bridge en sélectionne une, même avec une session `plan` ou une politique `deny`.

Un faux agent ACP, lancé avec Node et relié au client par stdio, a fourni uniquement `{ kind: "allow_once", optionId: "WRITE_ALLOWED" }`. Le client configuré en `deny` a réellement répondu :

```json
{"outcome":{"outcome":"selected","optionId":"WRITE_ALLOWED"}}
```

**Correction :** supprimer le choix par défaut de la première option. Si aucune option compatible avec la politique n’existe, répondre avec l’issue `cancelled`. Valider aussi la structure des options et refuser les permissions d’une session inconnue ou annulée.

Tests attendus : politique `deny` avec seulement des autorisations, session `plan`, liste vide, session inconnue, options malformées et permission reçue après annulation. Dans chacun de ces cas, aucune option `allow_*` ne doit être sélectionnée.

## A03 — Vérifier le dossier effectif d’une session avant l’autorisation

Références : `src/tools/agent-tools.js:73`, `src/tools/agent-tools.js:109`, `src/agents/acp/acp-adapter.js:93`, `src/agents/acp/acp-adapter.js:152`.

L’autorisation porte sur le `cwd` de la demande. Avec un `session_id`, l’adaptateur ACP choisit pourtant le client propriétaire de la session et son dossier mémorisé. Il ne rejette pas une contradiction entre ce dossier et le `cwd` annoncé.

Scénario confirmé avec un client instrumenté : créer `s1` dans A, puis appeler `ask` avec `sessionId: "s1"`, `cwd: B` et `mode: "default"`. L’adaptateur reconfigure `s1` et lui envoie le prompt ; il ne crée pas de session en B. Au niveau MCP, le jeton aurait été vérifié pour B. Cela invalide la garantie de portée du jeton pour cette reprise, même si l’agent conserve sa propre sandbox.

**Correction :** résoudre d’abord l’identité et le dossier effectif de la session, puis vérifier l’autorisation sur ce dossier. Refuser tout identifiant inconnu et tout `cwd` incompatible ; appliquer cette règle à la reprise, au retry et aux appels directs d’adaptateur.

La portée des chemins nécessite aussi des tests sur les liens symboliques et les jonctions : `src/security/caller-context.js:57` utilise une comparaison lexicale avec `path.relative`. Un chemin situé lexicalement sous A peut cibler physiquement un autre dossier. Canonicaliser les répertoires existants et définir une règle pour les chemins inexistants ; ne pas présenter cette seule canonicalisation comme une protection contre toutes les substitutions concurrentes de liens.

Critère d’acceptation : une autorisation pour B ne permet jamais de reprendre une session située en A. Les variantes de casse Windows et les alias de chemins ont un comportement explicite et testé.

## A04 — Faire correspondre le plan d’installation à la commande réellement exécutable

Références : `src/cli/installer-command.js:52`, `src/cli/installer-command.js:70`, `src/cli/installer-command.js:75`.

La validation repose sur des champs déclarés par le modèle : `sourceType: "official"`, un éditeur textuel et des URL HTTPS. Elle vérifie ensuite seulement qu’un argument contient la version annoncée. Elle ne démontre ni la provenance du paquet, ni la concordance entre paquet annoncé et paquet exécuté, ni même que la sous-commande réalise une installation.

Le plan fictif suivant passe la validation : paquet annoncé `expected-package`, version `1.2.3`, commande `npm uninstall -g different-package-1.2.3`, preuves pointant vers `https://example.invalid`. Le programme de vérification `node` avec des arguments d’évaluation est également accepté. Aucune de ces commandes n’a été exécutée.

Le dialogue de confirmation présent dans l’installateur reste utile, mais ne corrige pas cette incohérence ; avec `--execute --yes`, le plan généré peut atteindre directement l’exécution.

**Correction :** construire les commandes à partir de données validées, avec un générateur spécifique à chaque gestionnaire. Exiger la sous-commande attendue, la correspondance exacte du paquet et de sa version, et limiter la vérification au binaire attendu avec des arguments de lecture connus. Ne pas autoriser des interpréteurs arbitraires comme commande de vérification. Si la provenance ne peut pas être établie indépendamment des affirmations du modèle, conserver le plan comme proposition non exécutable automatiquement.

Tests : mauvais paquet, mauvaise sous-commande, version cachée dans un argument sans rapport, URL invérifiable et programme de vérification arbitraire doivent être refusés.

## A05 — Unifier le lancement des exécutables Windows

Références : `src/cli/installer-command.js:124`, `src/agents/declarative-adapter.js:25`, `src/agents/opencode/opencode-acp-client.js:12`, `src/controllers/controller.js:69`.

L’installateur transforme `npm` et `pnpm` en `npm.cmd` et `pnpm.cmd`, puis utilise `shell: false`. Le test réel de la même primitive avec `npm.cmd --version` produit `EINVAL` sur la machine d’audit. Les adaptateurs déclaratifs appliquent aussi un lancement direct sans traitement des `.cmd`.

Node documente le besoin d’un interpréteur pour lancer les fichiers batch Windows. Le lancement direct fonctionne pour les exécutables natifs, pas uniformément pour les shims de gestionnaires de paquets. [Documentation Node — lancement des fichiers batch Windows](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).

OpenCode a un autre défaut : sa chaîne `${OPENCODE_BIN} acp` ne protège pas un chemin contenant des espaces. Ce cas vient de l’inspection du code ; il n’a pas fait l’objet d’un lancement réel. Le contrôleur Claude possède encore un troisième traitement, avec sa propre fonction de citation.

**Correction :** extraire une petite fonction commune de résolution et de lancement des exécutables. Garder le lancement direct pour les binaires natifs et traiter explicitement les shims Windows, avec citation correcte et validation des arguments. Éviter d’activer globalement `shell: true` sur des arguments fournis par un modèle. Utiliser `windowsHide: true` pour les processus de fond ; conserver l’interaction visible lorsqu’une CLI doit réellement dialoguer avec l’utilisateur.

Tests d’intégration sans authentification : faux `.exe`/script Node et `.cmd`, chemin avec espaces et accents, arguments contenant guillemets et caractères spéciaux, binaire absent, `PATH` minimal et répertoire courant distinct du dépôt.

## A06 — Protéger les écritures concurrentes et la compaction

Références : `src/config/config-manager.js:48`, `src/config/config-manager.js:96`, `src/config/config-manager.js:246`, `src/usage/usage-manager.js:79`, `src/usage/usage-manager.js:106`.

`configManager.set` effectue une lecture, une modification et une écriture sans verrou. Deux appels peuvent lire le même état puis écraser chacun le changement de l’autre. Le nom temporaire `${file}.${process.pid}.tmp` ajoute une collision possible entre opérations du même processus. Un renommage atomique ne rend pas atomique toute la transaction de lecture/modification/écriture.

La compaction du ledger lit les entrées, archive les anciennes, écrit les totaux puis remplace le ledger. Un `record` intercalé après la lecture peut disparaître du fichier remplacé ; deux compactages peuvent traiter les mêmes entrées. Une panne entre l’écriture des totaux et le remplacement laisse aussi un risque de double traitement à la reprise.

Ces défauts découlent de l’ordre des opérations et de l’absence de verrou ; l’audit n’a pas injecté de panne disque ni mesuré leur fréquence.

**Correction :** reprendre le mécanisme de verrou interprocessus déjà présent dans le gestionnaire d’autorisations, donner des noms temporaires uniques aux écritures et nettoyer leurs restes après échec. Sérialiser ajout/compaction du ledger et rendre la compaction récupérable par génération ou identifiants d’entrées. Pour une proposition modifiant plusieurs fichiers, définir un protocole de reprise plutôt que supposer une transaction globale.

Critères : deux modifications de clés distinctes sont conservées ; aucune entrée de consommation ne se perd ou ne compte deux fois ; un redémarrage après chaque étape de compaction retrouve les mêmes totaux.

## A07 — Attendre la fin des tâches et des écritures à l’arrêt

Références : `src/mcp-server.js:66`, `src/runs/run-journal.js:43`, `src/runs/run-journal.js:134`, `src/agents/acp/acp-client.js:324`, `src/agents/codex/codex-adapter.js:82`.

Le serveur appelle `stopAll()` puis `process.exit(0)` immédiatement. Les écritures du journal sont asynchrones et une fonction `flush()` existe déjà, mais l’arrêt ne l’attend pas. Les derniers événements peuvent donc manquer après un arrêt normal.

Les adaptateurs appellent principalement `kill()` sur le processus direct. Cela ne prouve pas que le processus a terminé et ne garantit pas l’arrêt de ses descendants. Node documente notamment la survie possible des enfants d’un processus tué sous Linux. [Documentation Node — arrêt d’un sous-processus](https://nodejs.org/api/child_process.html#subprocesskillsignal).

**Correction :** rendre l’arrêt asynchrone et idempotent, refuser les nouveaux runs, demander l’annulation, attendre un délai borné, puis terminer les processus encore présents avec une stratégie adaptée à l’OS. Attendre les promesses de terminaison et `journal.flush()` avant de quitter. Traiter aussi la fermeture du transport MCP, pas uniquement les signaux.

Autre limite multiprocessus : `markInterrupted()` considère tous les runs actifs du journal comme interrompus au démarrage (`src/runs/run-journal.js:93`). Avec deux bridges partageant le même dossier de données, le second peut marquer les tâches du premier comme interrompues. Ajouter un identifiant d’instance et une preuve d’activité, ou imposer explicitement une seule instance par dossier de données.

Tests : arrêt pendant un prompt, processus ignorant l’annulation, descendant encore vivant, vidange du journal et coexistence de deux bridges. Les essais sur les descendants restent à exécuter sur les systèmes cibles.

## A08 — Valider les enveloppes ACP et borner les données avant le parsing

Références : `src/agents/acp/acp-client.js:102`, `src/agents/acp/acp-client.js:116`, `src/agents/acp/acp-client.js:277` ; logique similaire à inspecter dans `src/agents/codex/codex-adapter.js:100`.

Le client ignore le JSON invalide, mais traite ensuite tout JSON valide comme un objet. Une ligne `null`, valide en JSON, conduit à lire `msg.id` sur `null` hors du bloc `try`. Une CLI défectueuse peut ainsi provoquer une exception non interceptée dans le gestionnaire de ligne et arrêter le bridge.

Les plafonds actuels portent sur le texte collecté après réception. `readline` peut accumuler une ligne très longue avant un saut de ligne ; le plafond de 1 000 appels d’outils ne limite pas la taille de chaque objet. La limite annoncée ne borne donc pas l’ensemble du transport ni toute la mémoire retenue.

**Correction :** borner les octets en entrée avant de découper et parser les messages ; valider les objets JSON-RPC et les champs utilisés ; limiter la taille cumulée des données d’outils. Convertir les erreurs de protocole en échec du client concerné, sans laisser une exception remonter depuis un callback d’événement.

Tests : `null`, tableau, réponse incomplète, `session/update` malformé, ligne surdimensionnée sans fin de ligne et gros objet d’outil. Ce constat est statique ; aucun essai d’épuisement mémoire n’a été effectué.

## A09 — Appliquer le plafond de concurrence à toutes les délégations

Références : `src/tools/agent-tools.js:74`, `src/runs/run-manager.js:107`, `src/runs/run-manager.js:141`.

`agent_start` et `agent_fanout` passent par `runManager`, mais `agent_ask` appelle directement `registry.get(...).ask()`. Des demandes synchrones réparties sur plusieurs sessions ou dossiers peuvent donc démarrer des agents sans respecter `maxConcurrentPerAgent`. Les files de session protègent l’ordre d’une conversation, pas le nombre global de processus.

Ce chemin a aussi une comptabilisation différente : si `usageManager.record()` échoue après une réponse réussie, `agent_ask` renvoie une erreur. Le superviseur ignore au contraire cette erreur de comptabilité. Un appelant peut relancer une tâche déjà réalisée simplement parce que l’écriture du ledger a échoué.

**Correction :** faire passer `agent_ask` par le superviseur puis attendre son résultat, ou placer un ordonnanceur commun sous les deux parcours. Séparer explicitement le résultat de la tâche et l’état de sa comptabilisation ; rendre une panne du ledger observable sans transformer la tâche réussie en invitation à la refaire.

Critères : des appels concurrents à `agent_ask` ne dépassent jamais le plafond configuré ; un échec de comptabilisation n’efface pas le résultat obtenu et produit un diagnostic accessible.

## A10 — Démontrer la portabilité dans la CI et dans le paquet distribué

Références : `.github/workflows/ci.yml:16`, `.github/workflows/release.yml:17`, `package.json:32`, `package.json:42`.

La CI teste Node 20/22/24 uniquement sur Ubuntu. Le workflow release utilise également Ubuntu et Node 22. Aucun des deux n’exécute `pnpm lint`. Les tests locaux réalisés ici utilisent Node 25 ; ils complètent cette matrice sans prouver le fonctionnement sur ses autres cases.

Le champ `engines` accepte Node `>=20`, alors que le script de test utilise `--test-timeout`, ajouté dans Node 20.11.0. Les premières versions 20.x ne satisfont donc pas le parcours de développement annoncé. Cela ne démontre pas à lui seul une incompatibilité du serveur en production. [Documentation Node 22.4 — option de timeout des tests](https://nodejs.org/download/release/v22.4.0/docs/api/cli.html#--test-timeout).

Le script `test` contient une liste manuelle de fichiers. Un nouveau test oublié dans cette liste ne s’exécutera pas en CI. Le champ `files: ["src", "README.md"]` prévoit aussi d’embarquer les tests et smoke tests avec les sources ; vérifier le contenu réel d’un tarball avant de décider ce qui doit en être exclu.

**Correction proposée :** une matrice Ubuntu/Windows/macOS, avec Node 22 et 24 comme cible initiale à confirmer selon le support voulu. Si Node 20 reste contractuel, conserver sa case et préciser le minimum réellement testé. Exécuter tests, lint, création de paquet et un test d’installation depuis ce paquet dans un répertoire temporaire extérieur au dépôt. Épingler également la version de l’outil de release aujourd’hui invoqué par `npx @medyll/idae-pnpm-release --verbose` sans version explicite.

Pour découvrir les tests automatiquement, employer une sélection contrôlée des `*.test.js` : un simple élargissement à tous les fichiers contenant « test » pourrait déclencher les smoke tests qui lancent de vrais agents.

## Matrice de portabilité à compléter

| Dimension | Situation observée | Validation nécessaire |
|---|---|---|
| Windows x64 | 139 tests et lint passent ; lancement `.cmd` défectueux | Corriger A05 puis tester les exécutables natifs et shims réels |
| Linux | Workflow Ubuntu défini, résultats distants non consultés | Suite, paquet installé, signaux et descendants |
| macOS | Pas de job défini | Suite, chemins, exécution arm64 et cycle de vie |
| Node | Tests locaux sur 25.2.1 ; matrice déclarée 20/22/24 | Tester les versions promises et leur minimum |
| Installation globale / `pnpm dlx` / npx | Non exécutée | Vérifier le point d’entrée depuis un dossier différent du dépôt |
| Chemins avec espaces, accents, liens ou jonctions | Plusieurs traitements divergent | Scénarios A03/A05 avec chemins réels |
| Répertoire du projet en lecture seule | Données par défaut dans `.acp-team` sous le dossier du bridge | Tester `AGENT_BRIDGE_DATA_DIR` dans un dossier inscriptible distinct |
| Plusieurs clients MCP pour le même projet | Autorisations verrouillées, autres fichiers partagés insuffisamment protégés | Tests de concurrence et séparation des instances |
| Machines sans CLI d’agent / sans réseau | Cas simulés dans plusieurs tests ; parcours complet non validé | Diagnostic utile, temps d’attente borné, aucune initialisation inutile d’un agent désactivé |
| Déplacement vers une autre machine | Les autorisations contiennent des chemins absolus | Séparer configuration exportable et état local ; recréer les autorisations après déplacement |

Le serveur calcule son dossier de données dans `src/mcp-server.js:20`. Documenter les différences entre dossier de travail, emplacement des données et installation du paquet. Un export de configuration devrait exclure les autorisations, identifiants de sessions et chemins de binaires propres à la machine ; un import devrait les signaler au lieu de réutiliser silencieusement ces valeurs.

## Améliorations complémentaires

**Clarifier le modèle de confiance du plugin OpenCode.** `src/security/caller-context.js:36` fait confiance au nom d’hôte fourni lorsque cet hôte figure dans l’allowlist. Le plugin écrase normalement le contexte fourni par le modèle (`src/integrations/opencode-plugin.js:22`), mais la sécurité dépend de son exécution effective avant chaque appel. Le bridge ne vérifie pas cette provenance lui-même. Documenter que cette option exige un canal contrôlé par l’hôte, tester les appels sans hook et ne pas déduire des permissions effectives du seul nom de l’agent : `modeForOpenCodeAgent()` classe tout nom non reconnu comme `default`.

**Distinguer confirmation textuelle et autorisation vérifiable.** En mode d’outils `full`, `config_apply` accepte `confirm: "apply"` (`src/tools/config-tools.js:39`). Ce champ, contrôlé par l’appelant, ne prouve pas une approbation humaine. Définir si l’hôte porte cette garantie ou si les changements sensibles doivent exiger une autorisation liée à la proposition et à son contenu. Les réglages de commandes d’agents méritent particulièrement cette distinction.

**Renforcer les contrats sans migration générale.** Ajouter des types JSDoc vérifiés ou des schémas aux frontières : résultats d’adaptateurs, événements, données de configuration et enveloppes ACP. Les objets internes peuvent rester en JavaScript. Commencer par les contrats qui ont permis A01, A03 et A08 plutôt que convertir tous les fichiers.

**Documenter les garanties exactes.** Le journal exclut volontairement prompts et réponses, mais conserve les erreurs reçues (`src/runs/run-journal.js:39`). Une erreur de fournisseur peut contenir des extraits sensibles ; définir et tester leur nettoyage. Ne pas annoncer un budget bloquant si sa vérification reste un outil facultatif, et ne pas confondre un compteur d’usage absent avec un usage nul.

**Conserver les correctifs déjà présents.** `authorizationManager.consumeMany()` existe et le fan-out l’utilise maintenant (`src/tools/agent-tools.js:157`). Le problème de consommation partielle signalé dans `REVIEW_CLAUDE.md` n’est donc pas à recopier comme un défaut actuel. Les tests de verrouillage des autorisations et de protection contre les clés de prototype constituent des acquis à préserver.

## Ordre de réalisation proposé

| Lot | Travail | Condition de sortie |
|---|---|---|
| 1 — Autorisations | A01, A02, A03 | Tests négatifs aux entrées MCP et aux adaptateurs ; aucune élévation par option ou changement de dossier |
| 2 — Installation et Windows | A04, A05 | Plan cohérent, vérification limitée, shims et chemins réels testés |
| 3 — Persistance et arrêt | A06, A07 | Tests concurrents et redémarrages contrôlés ; pas de perte ni double comptage |
| 4 — Transport et supervision | A08, A09 | Messages malformés isolés, mémoire bornée, plafond commun de concurrence |
| 5 — Distribution | A10 et matrice de portabilité | Jobs multi-OS verts et test du paquet installé hors dépôt |

Chaque lot doit ajouter les tests qui reproduisent son défaut avant correction, puis rejouer la suite et le lint. Les tests d’agents réels restent une étape distincte, avec versions de CLI consignées et environnement d’authentification prévu. La portabilité pourra être déclarée validée pour les combinaisons effectivement testées lorsque les parcours d’installation, de délégation et d’arrêt auront tous réussi.
