# Étape 4 : comptes et alertes (installation)

But : permettre aux gens de se connecter (par courriel, sans mot de passe), de garder leur liste sur tous leurs appareils et de recevoir des alertes sur leur téléphone.

Tant que ces étapes ne sont pas faites, le site fonctionne exactement comme avant (aucun bouton de compte).

## Règle d'or

**Ne collez jamais une clé dans un chat ni dans un courriel.** La clé « service » (secrète) va seulement dans les secrets de GitHub (étape 5). Ne la mettez jamais dans `supabase.json`.

## 1. Créer le projet Supabase (gratuit)

1. Allez sur https://supabase.com et créez un compte gratuit.
2. Cliquez « New project ». Choisissez un nom (ex. : bons-plans), un mot de passe de base de données (gardez-le dans un endroit sûr, on n'en a pas besoin ici) et la région la plus proche (ex. : Canada Central).
3. Attendez 1 à 2 minutes que le projet soit prêt.

## 2. Coller le fichier schema.sql

1. Dans Supabase, menu de gauche : « SQL Editor » puis « New query ».
2. Ouvrez le fichier `supabase/schema.sql` de ce dossier, copiez tout, collez dans Supabase.
3. Cliquez « Run ». Vous devriez voir « Success ».

## 3. Régler l'adresse de connexion

Dans Supabase : « Authentication » puis « URL Configuration ».

- **Site URL** : `https://gcbsoh-boop.github.io/bons-plans/`
- **Redirect URLs** (cliquez « Add URL ») : `https://gcbsoh-boop.github.io/bons-plans/souhaits.html`

Cliquez « Save ». (Sans cela, le lien reçu par courriel ne ramène pas au site.)

Conseil : dans « Authentication » puis « Providers », laissez « Email » activé (les liens magiques fonctionnent sans mot de passe).

## 4. Récupérer les clés

Dans Supabase : « Project Settings » puis « API » (ou « API Keys »).

- **Project URL** : ressemble à `https://xxxxx.supabase.co`
- **anon / publishable key** : la clé PUBLIQUE (faite pour être visible).
- **service_role key** : la clé SECRÈTE. Ne la copiez que pour l'étape 5.

## 5. Les ajouter à GitHub

Sur GitHub, dépôt `bons-plans` : « Settings » puis « Secrets and variables » puis « Actions ».

Onglet **Variables** (« New repository variable ») :
- `SUPABASE_URL` = le Project URL
- `SUPABASE_ANON_KEY` = la clé anon / publishable

Onglet **Secrets** (« New repository secret ») :
- `SUPABASE_SERVICE_KEY` = la clé service_role (secrète)

Puis : « Actions » puis « Mise a jour du site » puis « Run workflow ». Après 1 à 2 minutes, le lien « Se connecter » apparaît dans le menu du site.

## 6. Pour essayer sur votre ordinateur (facultatif)

1. Copiez `supabase.exemple.json` en `supabase.json`.
2. Remplacez les deux valeurs par le Project URL et la clé anon (publique seulement).
3. Lancez `node bons-plans.js`.

Le fichier `supabase.json` n'est jamais envoyé sur GitHub. Le lien de connexion par courriel ne fonctionne qu'avec l'adresse du site publié (étape 3).

## 7. Activer le CAPTCHA (facultatif)

Cela bloque les robots qui créeraient de faux comptes.

1. Dans Supabase, ouvrez **Authentication**, puis **Attack Protection**.
2. Activez « Enable CAPTCHA protection » et choisissez un fournisseur (hCaptcha ou Cloudflare Turnstile, tous deux gratuits).
3. Créez un compte gratuit chez ce fournisseur, copiez la clé secrète dans Supabase et enregistrez.

Attention : le site doit ensuite afficher le CAPTCHA dans le formulaire de connexion, sinon les connexions seront refusées. N'activez cette option que si vous avez ajouté ce morceau.

## Comment les gens s'en servent

1. Ils cliquent « Se connecter » (menu) et entrent leur courriel, puis cliquent sur le lien reçu.
2. Leur liste est gardée dans leur compte. S'ils avaient déjà une liste dans le navigateur, on leur propose de l'ajouter.
3. Pour les alertes : installer l'app gratuite « ntfy », toucher « S'abonner », entrer leur sujet privé (affiché sur la page), garder « Alertes activées ».

Le site envoie au plus 5 alertes par personne à chaque mise à jour (toutes les heures), et jamais deux fois la même offre.

## Si ça ne marche pas

- Pas de lien « Se connecter » : les variables GitHub manquent, ou relancez « Run workflow ».
- Le courriel n'arrive pas : regardez les indésirables. Le plan gratuit limite le nombre de courriels par heure.
- Pas d'alertes : vérifiez le secret `SUPABASE_SERVICE_KEY` et que l'app ntfy est abonnée au bon sujet.
- Mise à jour de la politique de confidentialité : le site collecte désormais un courriel et une liste pour les personnes qui créent un compte. Pensez à modifier la page « Confidentialité » (elle dit encore « aucun compte »).
