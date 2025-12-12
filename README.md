# Synchronisation WooCommerce vers Odoo (Fonction Edge Supabase)

Ce projet synchronise les commandes de **WooCommerce** vers **Odoo Online** en utilisant une **Supabase Edge Function**. Il est conçu pour s'exécuter automatiquement via une tâche planifiée (Cron).

## 🚀 Fonctionnalités

- **WooCommerce** : Récupère les dernières commandes via l'API REST.
- **Odoo** : Crée les clients, produits et bons de commande via JSON-RPC.
- **Idempotence** : Vérifie si une commande (`WC-XXXX`) existe déjà dans Odoo pour éviter les doublons.
- **Automatisé** : S'exécute toutes les 5 minutes (configurable).
- **Serverless** : Hébergé sur Supabase Edge Functions (Deno/TypeScript).

## 🛠️ Installation

### Prérequis
- [Supabase CLI](https://supabase.com/docs/guides/cli) installée.
- Docker (requis pour le développement local/déploiement).

### 1. Cloner & Installer
```bash
git clone <url-de-votre-repo>
cd <dossier-du-repo>
```

### 2. Variables d'environnement
Créez un fichier `.env` à la racine avec vos identifiants :

```env
WOO_URL="https://votre-site.com"
WOO_CK="ck_votre_consumer_key"
WOO_CS="cs_votre_consumer_secret"

ODOO_URL="https://votre-instance-odoo.odoo.com"
ODOO_DB="nom-de-votre-base"
ODOO_EMAIL="votre-email@exemple.com"
ODOO_PASSWORD="votre-mot-de-passe-odoo"
```

## 📦 Déploiement

1. **Connexion à Supabase :**
   ```bash
   npx supabase login
   npx supabase link --project-ref <votre-identifiant-projet>
   ```

2. **Configurer les secrets :**
   ```bash
   npx supabase secrets set --env-file .env
   ```

3. **Déployer la fonction :**
   ```bash
   npx supabase functions deploy sync-orders
   ```

## ⏰ Planification (Cron)

Comme la CLI Supabase ne configure plus automatiquement les Crons pour la production, vous devez l'activer via l'**Éditeur SQL** dans votre tableau de bord Supabase :

1. **Activer les extensions** (si ce n'est pas déjà fait) :
   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;
   ```

2. **Créer la planification** (ex: toutes les 5 minutes) :
   Remplacez `VOTRE_CLE_SERVICE_ROLE` par votre vraie clé **service_role** (Paramètres > API).

   ```sql
   select
     cron.schedule(
       'sync-orders-every-5-min',
       '*/5 * * * *',
       $$
       select
         net.http_post(
             url:='https://<votre-identifiant-projet>.supabase.co/functions/v1/sync-orders',
             headers:='{"Content-Type": "application/json", "Authorization": "Bearer VOTRE_CLE_SERVICE_ROLE"}'::jsonb,
             body:='{}'::jsonb
         ) as request_id;
       $$
     );
   ```

## 🔍 Vérification

- **Vérifier les Logs** : Allez dans Dashboard Supabase > Edge Functions > `sync-orders` > Logs.
- **Déclenchement Manuel** :
  ```bash
  curl -i --location --request POST 'https://<votre-identifiant-projet>.supabase.co/functions/v1/sync-orders' \
    --header 'Authorization: Bearer <votre-cle-anon>'
  ```

## 📂 Structure du Projet

```
├── supabase
│   ├── functions
│   │   └── sync-orders
│   │       └── index.ts    # Logique de synchro principale (TypeScript)
│   └── config.toml         # Config Supabase
├── .env                    # Secrets (Non commité)
└── README.md
```
