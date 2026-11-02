# L’écran d’accueil : où vivent vos fichiers

Accueil est la page de démarrage de GenOffice : le bureau avec vos icônes et le dock en bas de la fenêtre, les listes de fichiers et les cartes de création rapide au centre.

![L’écran d’accueil](img/home-screen.png)

## Le dock

- **Récents** : les fichiers que vous avez ouverts récemment. Chaque ligne est datée — aujourd’hui, hier ou la date.
- **Favoris** : les fichiers que vous avez mis en favori. Survolez une ligne et cliquez sur l’étoile pour l’ajouter ou le retirer. **Déplacer vers un groupe** dans le menu ⋯ range les fichiers étoilés dans des groupes nommés ; la vue Étoilés filtre par groupe.
- **Ask AI** : le panneau de base de connaissances — posez des questions et recevez des réponses citées depuis vos fichiers étoilés (voir ci-dessous).
- **Genspark Projects** : après connexion à votre compte Genspark, affiche les projets que vous avez créés avec Genspark AI sur le web ; cliquez sur l’un pour continuer à modifier dans le navigateur. Recherche, tri par date, actualisation et chargement de davantage d’éléments sont pris en charge.
- **Dossiers** : les racines vivent sur le bureau. Faites un clic droit sur le bureau vide pour **Ajouter un dossier au bureau…** ; un clic droit sur l'icône d'une racine la retire du bureau (le dossier sur le disque n'est jamais touché). Une racine s'ouvre en vue propre : parcourir, créer des sous-dossiers, renommer et déplacer se font depuis là. Glisser des fichiers depuis le gestionnaire de fichiers les épingle comme alias.

Le dock en bas de la fenêtre est le lanceur, à la macOS : les icônes s'agrandissent sous le pointeur, un point marque la vue active, faites glisser pour réordonner au sein d'un groupe, clic droit pour le menu. Réglages → Dock désactive l'agrandissement, change la taille des icônes ou masque le dock (survolez le bord inférieur pour le rappeler). Le bureau porte aussi la carte de capture rapide de tâches — déplacez-la par sa poignée, la position est mémorisée.

Il n’y a pas d’entrée Corbeille ici. Les fichiers supprimés vont dans la corbeille du système, et les restaurer relève de l’OS.

## La liste des fichiers

Chaque ligne affiche une icône, le nom du fichier, la date de modification et autres informations. Le **menu ⋯** de la ligne propose :
### Plusieurs fichiers à la fois

Cochez la case d’une ligne, ou faites ⌘/ctrl-clic, pour composer une sélection ; la case d’en-tête sélectionne tout ce qui est actuellement listé, et une barre au-dessus de la liste indique (**{n} sélectionné(s)**) combien sont sélectionnés et offre **Déplacer vers un dossier…** ainsi que **Supprimer les fichiers** pour l’ensemble. Vous pouvez aussi faire glisser une multi-sélection sur une ligne de dossier de la vue dossier.

## Recherche

La zone de recherche en haut porte sur deux choses à la fois :
## Cartes de démarrage rapide

Les cartes au-dessus des listes créent un document en une étape. Cliquer sur une carte crée un fichier de ce type et ouvre son éditeur — vous pouvez écrire tout de suite, ou laisser l’IA le rédiger (chaque éditeur a un **bouton IA** dans son ruban, et **Demander à l’IA** dans le menu contextuel de sélection).

Le nouveau fichier atterrit dans la vue dossier où vous vous trouvez ; hors de tout dossier, il va dans le dossier par défaut.

Ce que fait chaque carte :
> Astuce : Fichier ▸ Nouveau dans la barre de menus crée les mêmes types de documents (⌘N/Ctrl+N crée un document texte par défaut) ; faire glisser un fichier dans la fenêtre l’ouvre.

## Interrogez votre base de connaissances

- Étoilez d'abord des fichiers (tout type que l'app lit) ; l'en-tête du panneau compte le corpus, et une base vide vous invite à aller étoiler.
- Les réponses citent leurs fichiers d'origine ; cliquez une citation pour ouvrir le fichier dans son éditeur.
- Nécessite une connexion Genspark. La conversation ne vit qu'en mémoire — fermer l'app y met fin.
- La recherche tourne sur l'index de fichiers local, comme la recherche de l'accueil ; les fichiers disparus sortent silencieusement du corpus.
- Les groupes n'organisent que la liste Étoilés — la base de connaissances couvre toujours tous les fichiers étoilés.

## Projets cloud (Genspark Projects)

- La première utilisation exige de se connecter à votre compte Genspark (flux par code d’appareil : GenOffice affiche un code, vous terminez la connexion dans le navigateur).
- La liste des projets se synchronise avec le web ; Ouvrir dans le navigateur y conduit pour continuer.
- Ne pas se connecter n’a aucune incidence sur les fonctions locales.
