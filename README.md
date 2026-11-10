# Révisions Campass

Application web **locale** (Flask + Tailwind) qui lit votre emploi du temps Campass (flux ICS) et place
automatiquement un créneau de révision **la veille (J-1)** de la prochaine occurrence de chaque cours.

## Démarrage

```bash
python -m venv .venv && source .venv/bin/activate      # Windows : .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                    # puis adaptez (ICS_URL, horaires…)
python app.py                                           # http://127.0.0.1:5000
pytest                                                  # tests du moteur de planification
```

L'interface charge Tailwind via CDN : une connexion Internet est nécessaire à l'affichage.

## Utilisation

1. **Synchronisation** : collez l'URL d'abonnement ICS de Campass ou importez un `.ics`.
2. **Matières** : réglez durée, intensité et nombre de chapitres ; l'agenda se recalcule.
3. **Calendrier** : glissez-déposez un créneau en pointillés (ou double-clic) pour le déplacer.
4. **Tableau de bord** : to-do du jour, jauge de charge, cases « Révisé ».

## Adapter l'analyse des titres Campass

Le titre est analysé de façon heuristique (CM/TD/TP/DS…). Si votre format diffère, renseignez
`SUMMARY_REGEX` dans `.env` avec les groupes nommés `subject` et `kind`.

## Règles de planification

- Occurrences regroupées par matière (`GROUP_BY=subject_kind` pour séparer CM/TD/TP).
- Créneau 1 à J-1 ; si la matière exige plusieurs créneaux, les suivants remontent à J-2, J-3…
  sans dépasser le cours précédent.
- Placement : premier trou libre après `PREFERRED_START`, en évitant cours et blocages ;
  journée saturée → créneau signalé « chevauchement ».
- Vos déplacements et cases cochées sont conservés à chaque resynchronisation.

## Sécurité

- Écoute sur `127.0.0.1` uniquement par défaut.
- Téléchargement ICS protégé contre le SSRF (IP privées refusées, redirections revalidées, 5 Mo max).
- Requêtes d'écriture exigeant l'en-tête `X-Requested-With` (anti-CSRF).
- L'URL ICS (souvent un jeton privé) est stockée dans `data/revisions.db`, jamais renvoyée en clair à l'interface ;
  `.env` et `data/` sont dans `.gitignore`.
