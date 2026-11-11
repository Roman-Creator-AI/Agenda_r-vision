# Révisions Campass

Application web (Flask + SQLite + Tailwind) qui lit ton emploi du temps (flux ICS de Campass / Geode) et place
automatiquement un créneau de révision **la veille (J-1)** de la prochaine occurrence de chaque cours.
Chaque utilisateur a son compte et son planning privés.

## Fonctionnalités

- **Comptes** : inscription / connexion par identifiant et mot de passe (haché avec Werkzeug), session personnelle.
- **Import ICS** : URL d'abonnement ou fichier `.ics`, rafraîchissement manuel ou automatique.
- **Planification J-1** : créneaux placés après tes cours, en évitant tes blocages ; déplaçables à la main.
- **Suivi** : chaque session se valide par **Fait** ou **Non fait**.
- **Dette de révision** : un « Non fait » ajoute 1 au compteur de retard de la matière ; le planificateur crée
  alors des créneaux de rattrapage dans les cycles suivants. Le compteur est modifiable à la main.
- **Charge** : durée, intensité et nombre de chapitres par matière ; jauge de charge quotidienne.
- **Blocages hebdomadaires** *(site statique `docs/`)* : « tous les lundis de 17h30 à 19h », avec dates de début / fin facultatives, en plus des blocages d'un jour précis.
- **Durée par créneau** *(site statique)* : bouton « Modifier » sur un créneau pour fixer sa durée sans toucher aux autres créneaux de la matière.
- **Cours ajoutés à la main** *(site statique)* : une fois, chaque semaine ou toutes les N semaines, sur les jours de ton choix ; ils reçoivent leurs révisions comme les cours importés.

### Règles du suivi et de la dette

| Action | Effet sur le compteur de retard de la matière |
|---|---|
| « Non fait » sur une session normale | +1 (le travail est reporté) |
| « Fait » sur une session de rattrapage | −1 (dette remboursée) |
| « Non fait » sur un rattrapage | 0 (la dette existe déjà, un nouveau rattrapage est replanifié) |
| « Annuler » | annule exactement l'effet précédent |
| Ajustement manuel (page Matières) | remplace la valeur |

- Les rattrapages ne sont **jamais planifiés aujourd'hui** : ils partent dans un cycle dont la fenêtre de révision
  (J-1 du cours) commence demain ou plus tard, au plus `EXTRA_CAP_PER_CYCLE` (2 par défaut) par cycle.
- Une session jamais validée reste « en retard » dans la to-do. Au-delà de `HISTORY_DAYS` jours (7 par défaut),
  elle disparaît de l'agenda **sans** compter dans la dette : pense à la marquer « Non fait ».

## Architecture

```
agenda_r-vision/
├── app.py              # Flask : routes (comptes, API JSON), garde-fous CSRF / session
├── auth.py             # hachage, validation des identifiants, CSRF, limitation des tentatives
├── db.py               # SQLite multi-utilisateurs (users, courses, subjects, session_state, blocks, settings)
├── planner.py          # moteur pur : J-1, charge, dette, rattrapages (sans accès base)
├── ics_service.py      # téléchargement sécurisé (anti-SSRF) et analyse ICS
├── config.py           # configuration via variables d'environnement
├── wsgi.py             # point d'entrée pour l'hébergeur (gunicorn wsgi:app)
├── Procfile            # commande de démarrage (Render, Railway, Heroku-like)
├── render.yaml         # blueprint Render (offre payante + disque persistant)
├── templates/          # home.html (connexion / inscription), index.html (application)
├── static/app.js       # interface (calendrier, to-do, Fait / Non fait, matières)
├── tests/              # pytest : planificateur, dette, application complète
└── .env.example        # toutes les variables de configuration
```

## Démarrage en local

Python **3.10 ou plus récent** est nécessaire.

```bash
python3 -m venv .venv && source .venv/bin/activate     # Windows : .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python app.py                                           # http://127.0.0.1:5000
pytest                                                  # 39 tests
```

L'interface charge Tailwind via un CDN : une connexion Internet est nécessaire pour l'affichage.
Une base créée par la version sans comptes est sauvegardée (`revisions.db.bak-v1-…`) puis remplacée.

## Déploiement en ligne

**Point décisif : SQLite écrit dans un fichier. Il faut donc un disque qui survit aux redémarrages.**

| Hébergeur | Données conservées ? | Lien ICS Geode | Coût |
|---|---|---|---|
| **PythonAnywhere** (compte gratuit) | Oui (512 Mo de stockage) | Accès sortant limité à une liste de sites : le lien ICS risque d'être bloqué, importe plutôt le fichier `.ics` | Gratuit |
| **Render** offre gratuite | **Non** : disque éphémère, effacé à chaque redémarrage ou mise en veille (après 15 min d'inactivité) | Oui | Gratuit, inutilisable avec SQLite |
| **Render** offre « starter » + disque | Oui | Oui | Payant |

Vérifié dans la documentation de [Render](https://render.com/docs/free) et la [grille PythonAnywhere](https://www.pythonanywhere.com/pricing/)
en novembre 2026. Les offres changent : revérifie avant de t'engager. La liste blanche de PythonAnywhere
est consultable sur [cette page](https://www.pythonanywhere.com/whitelist/), et un ajout se demande via leur
[page d'aide](http://help.pythonanywhere.com/pages/RequestingAllowlistAdditions/).

### Variables à définir en ligne

| Variable | Valeur |
|---|---|
| `SECRET_KEY` | longue chaîne aléatoire : `python -c "import secrets; print(secrets.token_hex(32))"` |
| `SESSION_COOKIE_SECURE` | `1` (cookie envoyé seulement en HTTPS) |
| `TRUST_PROXY` | `1` (lit la vraie IP du client derrière le proxy de l'hébergeur) |
| `INVITE_CODE` | un code que seuls tes proches connaissent (sinon n'importe qui peut créer un compte) |
| `DB_PATH` | chemin sur un disque persistant |
| `AUTO_REFRESH_MINUTES` | `0` sur PythonAnywhere gratuit (pas de tâche en arrière-plan) |

### Option A : PythonAnywhere (gratuit)

1. Crée un compte sur pythonanywhere.com. Ton adresse sera `https://TON-NOM.pythonanywhere.com` (HTTPS inclus).
2. Onglet **Consoles** → **Bash** :
   ```bash
   git clone https://github.com/TON-PSEUDO/Agenda_r-vision.git
   cd Agenda_r-vision
   python3.12 -m venv ~/venv && source ~/venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env && nano .env      # renseigne SECRET_KEY, INVITE_CODE, SESSION_COOKIE_SECURE=1,
                                          # TRUST_PROXY=1, AUTO_REFRESH_MINUTES=0
   ```
   Dépôt privé : clone avec `https://TON-PSEUDO:TOKEN@github.com/TON-PSEUDO/Agenda_r-vision.git`
   (token GitHub avec le droit `repo`).
3. Onglet **Web** → **Add a new web app** → **Manual configuration** (version de Python ≥ 3.10).
4. Dans l'onglet Web : *Source code* et *Working directory* = `/home/TON-NOM/Agenda_r-vision`,
   *Virtualenv* = `/home/TON-NOM/venv`.
5. Ouvre le fichier WSGI indiqué par l'onglet et remplace son contenu par :
   ```python
   import sys
   path = "/home/TON-NOM/Agenda_r-vision"
   if path not in sys.path:
       sys.path.insert(0, path)
   from wsgi import app as application
   ```
6. Clique sur **Reload**, puis ouvre ton adresse. Crée ton compte avec le code d'invitation.
7. Mises à jour : `cd ~/Agenda_r-vision && git pull`, puis **Reload**.

Vérifie dans l'onglet Web si PythonAnywhere demande de prolonger l'application périodiquement.

### Option B : Render (payant, avec disque)

1. Crée un compte sur render.com et relie ton dépôt GitHub.
2. **New → Blueprint** : Render lit `render.yaml` (service « starter » + disque de 1 Go monté sur `/var/data`).
3. Renseigne `INVITE_CODE` quand Render le demande. `SECRET_KEY` est générée automatiquement.
4. Chaque `git push` sur la branche suivie redéploie l'application.

## Sécurité : ce qui est en place, et ses limites

- Mots de passe hachés (scrypt, sinon PBKDF2) avec sel ; jamais stockés ni journalisés en clair.
- Cookie de session `HttpOnly`, `SameSite=Lax`, `Secure` en ligne ; session renouvelée à la connexion.
- Jeton CSRF sur toutes les écritures ; en-têtes `X-Frame-Options`, `nosniff`, `HSTS` en HTTPS.
- Limitation des tentatives de connexion (par identifiant + IP, et par IP) et des inscriptions.
- Isolation : toute requête SQL est filtrée par `user_id`.
- Téléchargement ICS protégé contre le SSRF (adresses privées refusées, redirections revérifiées, 5 Mo max).

Limites connues :
- La limitation des tentatives est en mémoire, par processus (elle se remet à zéro au redémarrage).
- Ton **lien ICS est stocké en clair** dans la base (c'est un jeton d'accès à ton planning). Ne partage pas le fichier
  `data/revisions.db` ni ses sauvegardes.
- Pas de récupération de mot de passe par e-mail : un mot de passe oublié se réinitialise en base à la main.
- Une session ouverte n'est pas révoquée côté serveur avant son expiration (`SESSION_DAYS`).
- Contrôle SSRF fait avant la requête : un DNS malveillant « à rebond » peut théoriquement le contourner.
  Garde `INVITE_CODE` actif pour limiter les inscrits à des personnes de confiance.

## Adapter l'analyse des titres

Le titre est découpé ainsi : « Mathématiques 1 - CS+R - CM - S12 » donne la matière « Mathématiques 1 », type CM.
Pour un autre format, renseigne `SUMMARY_REGEX` (groupes nommés `subject` et `kind`).

---

## 📱 Version site statique (GitHub Pages) — accessible depuis Safari

Le dossier `docs/` est une version **100 % navigateur** : pas de serveur, pas de compte. Le planning, les
dettes et les réglages sont calculés et stockés dans le navigateur (`localStorage`).

### Publier
1. Pousse la branche sur GitHub (et fusionne-la dans `main` quand tu es prêt).
2. GitHub → **Settings → Pages → Build and deployment** → *Deploy from a branch* → branche `main`, dossier **`/docs`**.
3. Le site apparaît à `https://<pseudo>.github.io/<nom-du-dépôt>/`.

> ⚠️ Avec un compte gratuit, GitHub Pages exige un dépôt **public**. Ton code sera donc visible, mais jamais tes
> données (elles ne quittent pas ton appareil). Si tu préfères garder le code privé, crée un second dépôt public
> contenant uniquement le contenu de `docs/`.

### Utiliser sur iPhone / iPad
1. Ouvre l'adresse dans Safari.
2. Bouton Partager → **Sur l'écran d'accueil** : l'app s'ouvre en plein écran.
3. Onglet « Import & sauvegarde » → importe ton fichier `.ics` exporté depuis Campass/Geode.

### Limites à connaître
- **Données locales** : elles ne se synchronisent pas entre appareils. Utilise *Exporter / Restaurer* (.json).
  Safari efface les données d'un site non ouvert pendant 7 jours, sauf s'il est ajouté à l'écran d'accueil :
  exporte régulièrement une sauvegarde.
- **Lien d'abonnement** : le serveur de l'école peut refuser la lecture depuis un autre site (CORS). Dans ce cas,
  utilise l'import de fichier `.ics` (aucun proxy tiers n'est utilisé, pour ne pas leur confier ton agenda).
- **Déplacer un créneau** : glisser-déposer sur ordinateur, bouton ⇄ sur écran tactile.

### Développement
```bash
cd tools && npm install && npm run build:css   # recompile docs/css/tailwind.css après modification de l'UI
npm run vendor                                  # met à jour ical.js dans docs/vendor
cd .. && node --test "tests-js/*.test.mjs"      # compare planificateur/lecteur ICS JS aux versions Python
python3 -m http.server -d docs 8000             # aperçu local
```
La version Flask (comptes, SQLite) reste disponible dans les autres branches / dossiers.
