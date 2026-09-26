# Sismed Marketing IA — Action de Prospectos

Esta primera Action permite que el GPT registre y gestione consultorios potenciales sin tocar la base clínica de Sismed.

## Funciones
- Crear prospectos.
- Listarlos y filtrar por estado.
- Actualizar estado, notas y próxima acción.
- No permite borrar registros desde el GPT.
- No debe almacenar información de pacientes.

## Despliegue recomendado
Usá una base MySQL separada de la base clínica.

1. Subí esta carpeta a un repositorio privado de GitHub.
2. En Railway, creá un nuevo servicio desde ese repositorio.
3. Agregá una base MySQL dedicada.
4. Configurá:
   - `ACTION_API_KEY`: clave larga y aleatoria.
   - `DATABASE_URL` o `MYSQL_URL`: conexión a MySQL.
5. Generá un dominio público HTTPS para el servicio.
6. Probá `https://TU-DOMINIO/health`. Debe responder `ok: true`.

## Configurar en el GPT
1. Abrí `openapi.yaml`.
2. Reemplazá `https://TU-DOMINIO-DE-RAILWAY.up.railway.app` por el dominio real.
3. En Sismed Marketing IA > Actions > Crear nueva acción:
   - Autenticación: API key.
   - Tipo: Bearer.
   - Secreto: el mismo valor de `ACTION_API_KEY`.
4. Pegá el contenido de `openapi.yaml` en Schema.
5. Guardá y probá en Vista previa.

## Política de privacidad
La API incluye `GET /privacy`. Si compartís públicamente el GPT, revisá y personalizá esa página antes de usarla como URL de privacidad.

## Estados
`nuevo`, `contactado`, `respondio`, `interesado`, `piloto`, `descartado`.

## Canales
`instagram`, `facebook`, `whatsapp`, `email`, `telefono`, `linkedin`, `web`, `visita`, `otro`.

## Pruebas sugeridas
- “Registrá como prospecto a Consultorio Demo, de San Miguel, encontrado en Instagram.”
- “Mostrame los prospectos nuevos.”
- “Actualizá el prospecto 1 a contactado y anotá que envié el mensaje inicial.”

## Seguridad
- No uses la misma base que almacena información clínica.
- No pegues la API key en las instrucciones del GPT.
- No guardes historias clínicas, diagnósticos ni datos de pacientes.
- Mantené aprobación humana antes de automatizar envíos o publicaciones.
