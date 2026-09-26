# Sismed Marketing IA - Render + PostgreSQL

1. Reemplazá el contenido del repo `sismed-marketing-action` por estos archivos.
2. En Render, creá una base PostgreSQL llamada `sismed-marketing-db`.
3. Copiá su Internal Database URL.
4. Creá un Web Service desde el repo.
5. Runtime: Node.
6. Build Command: `npm install`.
7. Start Command: `npm start`.
8. Plan: Free para pruebas.
9. Variables:
   - `DATABASE_URL` = Internal Database URL
   - `ACTION_API_KEY` = una clave larga y aleatoria
10. Health Check Path: `/health`.
11. Desplegá y abrí `/health`.

Después reemplazá `https://TU-SERVICIO.onrender.com` dentro de `openapi.yaml` por la URL real del servicio.
