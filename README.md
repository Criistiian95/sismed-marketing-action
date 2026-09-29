# Sismed Marketing IA — 3.5

Backend de CRM, imágenes e Instagram. Crea borradores y registra la aprobación de una versión antes de publicar o programar.

## Configuración y pruebas

Obligatorias: `ACTION_API_KEY`, `DATABASE_URL`.
Instagram: `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID`; opcional `INSTAGRAM_API_VERSION` (v26.0 por defecto).
Cloudflare: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`; opcionales `CLOUDFLARE_IMAGE_MODEL_FAST`, `CLOUDFLARE_IMAGE_MODEL_PREMIUM`. Se conserva `CLOUDFLARE_IMAGE_MODEL` como alternativa premium.
`PUBLIC_BASE_URL` debe ser la URL pública HTTPS. Las variables `OPENAI_*` no son usadas.

```sh
npm ci
npm test
npm start
```

`/health` prueba PostgreSQL y muestra 3.5.0; no verifica credenciales externas. Las pruebas usan PostgreSQL embebido (PGlite), HTTP local y proveedores simulados: no requieren secretos ni publican contenido.

## Flujo nuevo

1. Generar imagen con `request_id` único y estable.
2. Crear borrador con `request_id`, `image_id`, `caption`.
3. Mostrar imagen, copy, cuenta y horario. Esperar aprobación del usuario.
4. Aprobar por `id`, `revision` y `confirmacion: true`.
5. Publicar con `publication_id` y `revision`, o programar agregando `scheduled_at` futuro con zona horaria.

Editar la pieza incrementa revisión, elimina aprobación y retira la programación. Reprogramar el mismo contenido conserva aprobación. Cancelar solo funciona antes de iniciar la publicación.

**Alcance de la aprobación:** la API registra la declaración del cliente autenticado. No prueba por sí sola que una persona pulsó un botón: ese cliente tiene acceso a aprobar y publicar. Las instrucciones del GPT y la confirmación de Actions forman parte del control. Separación estricta requeriría una interfaz humana con credencial distinta.

La ruta combinada generar-y-programar responde 410 y se retiró de OpenAPI. Las llamadas antiguas que solo contienen `image_url` no publican.

## Duplicados, errores y cron

Manual y cron usan una reserva SQL única por publicación. Se guarda el contenedor antes de publicar y el estado `publicando` antes de llamar a Meta. Ante resultado incierto se pasa a `revision`, sin reenvío automático. La verificación por id consulta el contenedor; solo `PUBLISHED` confirma publicación. No inventa la hora exacta de publicación al reconciliar.

Si no hay contenedor persistido o el resultado sigue ambiguo, hace falta investigación manual. No crear otra pieza ni reiniciar estados para eludir la revisión. Trabajos sin actualización durante 15 minutos se aíslan al ejecutar el cron.

`request_id` evita repetir generación o creación de borrador con la misma clave; no impide duplicados intencionales con claves distintas. Un intento de imagen fallido o incierto no se vuelve a ejecutar automáticamente. Consultar imágenes antes de iniciar otro pedido.

El cron externo de cron-job.org sigue llamando `POST /api/instagram/procesar-programadas` con Bearer cada cinco minutos. No se agrega un segundo cron. Procesa hasta diez pendientes por ejecución; no garantiza el segundo exacto.

Devuelve 503 ante fallos nuevos o procesos interrumpidos detectados en esa ejecución. Si no hay errores nuevos devuelve 200, incluyendo `requieren_revision` para pendientes anteriores. **200 no significa que todas las piezas estén publicadas.** Los errores antiguos no fuerzan un fallo permanente que desactive el cron.

Las llamadas externas tienen timeout. Si el cliente agota su espera antes que el servidor, consultar el id en vez de repetir la creación. Revisar alertas y timeout del cron al desplegar; no ejecutar manualmente el procesador con contenido real pendiente sin autorización.

## Imágenes

Cloudflare genera fondo; Sharp/Pango mide y compone textos en 1024 × 1280. Si el texto no entra de manera legible, responde 422 antes de consumir Cloudflare; no corta líneas silenciosamente.

Las imágenes nuevas guardan fondo y textos. Editar textos crea otro id/URL sin llamar a Cloudflare y conserva la versión anterior. Las imágenes antiguas sin fondo separado no admiten esa edición (409). Guardar fondos aumenta almacenamiento; no se eliminan imágenes automáticamente.

La tipografía del panel es determinista, pero la IA aún puede generar letras indeseadas en el fondo: revisar la pieza completa. La marca compuesta es tipográfica, no un archivo del logo oficial.

## Despliegue coordinado

1. Revisar el PR y comprobar respaldo de PostgreSQL antes de desplegar. Conservar configuración anterior del GPT.
2. Desplegar 3.5 y comprobar `/health`.
3. Reemplazar esquema de Actions con `openapi.yaml` e instrucciones con `GPT_INSTRUCTIONS.md` (menos de 8.000 caracteres). Mientras se actualiza el GPT, las llamadas viejas de publicación quedan bloqueadas.
4. Validar borrador, edición, aprobación y cancelación. Una publicación real requiere aprobar su imagen/copy final.
5. Comprobar próxima ejecución del cron y estado individual.

La migración es aditiva e idempotente. Programaciones anteriores mantienen horario y reciben `legacy_pre_v35`, sin fecha ficticia de aprobación. Esto conserva la cola ya existente; exigir una nueva aprobación a esa cola requiere una decisión explícita del operador. Trabajos antiguos atascados se aíslan para revisión.

No volver a 3.4 con piezas nuevas activas: no comprende el control de aprobación. Si falla el despliegue, bloquear nuevas publicaciones y corregir 3.5; no borrar datos o columnas de la migración.

Las pruebas locales no sustituyen la validación contra Meta y Cloudflare después del despliegue.
