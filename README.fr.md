# git undo

[English](README.md) · **Français**

**Vous venez de faire quelque chose à votre dépôt. Ceci vous dit comment le
reprendre.** L'outil lit votre reflog, détermine quelle opération a réellement
eu lieu, et affiche la commande exacte qui l'annule — en langage clair, avec le
risque annoncé.

[![CI](https://github.com/CedricPoint/git-undo/actions/workflows/ci.yml/badge.svg)](https://github.com/CedricPoint/git-undo/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![dépendances](https://img.shields.io/badge/d%C3%A9pendances-0-brightgreen.svg)](package.json)
[![licence](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

```console
$ git undo

  git undo  ·  main

  You committed "add rate limiting to the API".  just now

  undo with   git reset --soft 73318d2
  it will     remove the commit and put its changes back in your staging area, untouched.
  risk        safe · nothing is thrown away

  run it with git undo --yes
```

*(L'outil s'exprime en anglais, comme git lui-même : ce qu'il affiche se colle
dans un terminal et se cite dans un rapport de bug.)*

Il fait la différence entre un commit, un amend, un reset, un merge, un rebase et
un stash — ce qui compte, parce que la commande qui annule chacun est différente,
et que se tromper est la meilleure façon de perdre un après-midi.

```console
$ git undo

  git undo  ·  hotfix

  You reset to HEAD~1.  just now

  undo with   git reset --hard abe706e
  it will     move the branch back to abe706e and restore every file to that state, 1 commit comes back.
  risk        destructive · files and commits are rewritten

  run it with git undo --yes
              a backup ref is written first, so this stays reversible
```

## Installation

```bash
# une fois, sans rien installer
npx github:CedricPoint/git-undo

# ou dans le PATH, et git le récupère comme une sous-commande
npm install -g github:CedricPoint/git-undo
git undo
```

Node 18 ou plus récent, et git. Aucune dépendance, aucun fichier de
configuration, aucun hook, rien à initialiser dans votre dépôt.

## Ce qu'il comprend

| ce que vous venez de faire | ce qu'il propose | risque |
| --- | --- | --- |
| un commit | `git reset --soft <parent>` | sans risque |
| votre tout premier commit | `git update-ref -d HEAD` | à surveiller |
| un `--amend` | `git reset --soft <avant>` | sans risque |
| un reset | `git reset --hard <avant>` | destructeur |
| un merge | `git reset --hard <avant>` | destructeur |
| un pull (merge ou rebase) | `git reset --hard <avant>` | destructeur |
| un rebase | `git reset --hard <avant tout le rebase>` | destructeur |
| un cherry-pick | `git reset --hard <avant la série>` | destructeur |
| un revert | `git reset --hard <avant>` | destructeur |
| un changement de branche | `git checkout <d'où vous veniez>` | sans risque |
| un `git stash` | `git stash pop` | à surveiller |
| un merge/rebase/cherry-pick en conflit | `git <celui-là> --abort` | sans risque |

Les opérations en plusieurs étapes sont traitées comme une seule chose : annuler
un rebase de quatre commits revient là où vous étiez avant le rebase, pas d'un
seul pick en arrière.

Le stash est le sournois — `git stash` écrit `reset: moving to HEAD` dans le
reflog sans rien déplacer, de sorte qu'une lecture naïve du reflog propose un
reset. L'outil recoupe avec le journal du stash et vous dit de faire un pop.

## Il n'exécute rien sans votre accord

- **Simulation par défaut.** Un `git undo` tout court ne fait que lire.
- **Une sauvegarde avant chaque modification.** `--yes` écrit la position de HEAD
  dans `refs/undo-backup/<horodatage>` avant de toucher à quoi que ce soit, et
  affiche l'unique commande qui remet tout en place. Rien ne peut être ramassé
  par le garbage collector dans votre dos.
- **Il refuse d'écraser du travail.** Si un `--hard` est en jeu et que des
  fichiers sont modifiés, il s'arrête et vous dit de commiter ou de stasher
  d'abord. `--force` est là quand vous le pensez vraiment. Les fichiers non
  suivis ne sont jamais une raison de refuser — un reset dur n'y touche pas.

```console
  refused     1 file in your working tree is modified, and this undo would overwrite it.
              Commit them, or run git stash -u first. Use --force to go ahead anyway.
```

## Les autres commandes

```bash
git undo list       # le reflog, en clair
git undo lost       # les commits que plus aucune branche ne désigne
git undo backups    # toutes les références de secours écrites par git undo
```

```console
$ git undo list

  recent history

  HEAD@{0}   just now         reset to HEAD~1
  HEAD@{1}   2 minutes ago    committed "add rate limiting to the API"
  HEAD@{2}   9 minutes ago    switched from main to hotfix
  HEAD@{3}   9 minutes ago    made the first commit, "set up the API"
```

`git undo lost` est celle à sortir quand des commits ont vraiment disparu : elle
liste ceux qui pendent dans le vide avec leur sujet et leur âge, ainsi que la
commande pour reposer une branche sur l'un d'eux.

Chaque commande accepte `--json`, ce qui la rend utilisable depuis vos propres
scripts :

```bash
git undo --json | jq -r '.plan.command | join(" ")'
```

```js
import { analyze, apply } from 'git-undo';

const { plan } = analyze();
if (plan?.risk === 'safe') apply(plan);
```

## Pourquoi pas un simple alias

`git undo` comme alias de `git reset --soft HEAD~1` est l'astuce habituelle, et
elle est fausse la plupart du temps : elle abîme un merge, elle ne sert à rien
après un rebase, et elle jette en silence un état en conflit. Tout l'intérêt ici
est de commencer par lire ce qui s'est réellement passé.

## Tests

37, et ce ne sont pas des simulacres : chacun construit un vrai dépôt dans un
dossier temporaire, lance de vraies commandes git (y compris celles qui partent
en conflit), et confronte le plan à ce que git a réellement écrit dans le
reflog :

```bash
npm test
```

```
ok   a rebase is undone as one operation, not one commit at a time
ok   a stash is recognised, even though git logs it as a reset
ok   an undo that would overwrite modified files refuses to run
ok   the backup really does bring everything back
ok   untracked files are not a reason to refuse
```

Ils tournent sur Linux, macOS et Windows, avec Node 18, 20 et 22.

## Licence

MIT
