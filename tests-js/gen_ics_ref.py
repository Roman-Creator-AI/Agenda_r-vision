"""Référence Python : analyse un fichier ICS avec ics_service.parse_ics et affiche le résultat en JSON.
Usage : python tests-js/gen_ics_ref.py fichier.ics AAAA-MM-JJ(début) AAAA-MM-JJ(fin)"""
import json
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from ics_service import parse_ics  # noqa: E402

data = open(sys.argv[1], "rb").read()
rows = parse_ics(data, date.fromisoformat(sys.argv[2]), date.fromisoformat(sys.argv[3]))
json.dump(rows, sys.stdout, ensure_ascii=False)
