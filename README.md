# Sismed Marketing IA — Instagram v2

Esta versión conserva el CRM de prospectos y agrega conexión con Instagram.

## Variables de Render necesarias
- ACTION_API_KEY
- DATABASE_URL
- INSTAGRAM_ACCESS_TOKEN
- INSTAGRAM_ACCOUNT_ID

Opcional:
- INSTAGRAM_API_VERSION=v26.0

## Qué agrega
- GET /api/instagram/status
- POST /api/instagram/publicar-imagen
- POST /api/instagram/programaciones
- GET /api/instagram/programaciones
- POST /api/instagram/programaciones/:id/publicar
- POST /api/instagram/procesar-programadas

## Orden de prueba
1. Subir server.js, package.json y openapi.yaml al repo.
2. Esperar el deploy automático de Render.
3. Abrir /health y verificar version 2.0.0.
4. Actualizar el esquema de la Action del GPT con openapi.yaml.
5. Probar: "Verificá la conexión con Instagram".
6. No publicar todavía hasta comprobar que el estado devuelve la cuenta correcta.

## Importante sobre imágenes
Meta descarga la imagen desde image_url. Por eso la URL debe ser HTTPS y públicamente accesible.
El archivo generado dentro de ChatGPT no es por sí mismo una URL pública permanente.
Después de validar Instagram, se puede agregar almacenamiento público para automatizar también la imagen.

## Programación automática
La API ya guarda programaciones y tiene un endpoint para procesarlas.
Todavía falta conectar un disparador horario. En Render, los Cron Jobs tienen costo mínimo;
para una prueba gratuita se puede usar GitHub Actions con una frecuencia razonable.
