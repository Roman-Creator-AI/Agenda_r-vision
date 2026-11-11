"""Point d'entrée WSGI pour l'hébergement : gunicorn wsgi:app (ou `application` sur PythonAnywhere)."""
from app import create_app

app = application = create_app(background=True)
