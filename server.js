require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const { Pool } = require("pg");
const { createHash } = require("node:crypto");
const { applySismedOverlay, prepareLayout, validateCopy } = require("./lib/image-layout");
const { migrate, registerRoutes } = require("./lib/publications");

const {migrateMedia,createReels}=require('./lib/reels');
const {cleanup}=require('./lib/retention');
const app = express();

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(express.json({ limit: "200kb" }));
app.use("/media", express.static("public"));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.ACTION_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const IG_VERSION = process.env.INSTAGRAM_API_VERSION || "v26.0";
const IG_BASE = `https://graph.instagram.com/${IG_VERSION}`;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_IMAGE_MODEL_FAST =
  process.env.CLOUDFLARE_IMAGE_MODEL_FAST ||
  "@cf/black-forest-labs/flux-1-schnell";

const CLOUDFLARE_IMAGE_MODEL_PREMIUM =
  process.env.CLOUDFLARE_IMAGE_MODEL_PREMIUM ||
  process.env.CLOUDFLARE_IMAGE_MODEL ||
  "@cf/leonardo/lucid-origin";
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://sismed-marketing-action.onrender.com";

if (!API_KEY || !DATABASE_URL) {
  console.error("Faltan ACTION_API_KEY o DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const ESTADOS = new Set([
  "nuevo",
  "contactado",
  "respondio",
  "interesado",
  "piloto",
  "descartado"
]);

const CANALES = new Set([
  "instagram",
  "facebook",
  "whatsapp",
  "email",
  "telefono",
  "linkedin",
  "web",
  "visita",
  "otro"
]);

const clean = (value, max = 255) => {
  if (value === undefined || value === null || value === "") return null;
  return String(value).trim().slice(0, max);
};

const parseDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

function requireInstagram() {
  if (!IG_TOKEN || !IG_ACCOUNT_ID) {
    const err = new Error(
      "Faltan INSTAGRAM_ACCESS_TOKEN o INSTAGRAM_ACCOUNT_ID en Render"
    );
    err.status = 503;
    throw err;
  }
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prospectos_sismed (
      id BIGSERIAL PRIMARY KEY,
      nombre_consultorio VARCHAR(200) NOT NULL,
      ciudad VARCHAR(120),
      contacto_nombre VARCHAR(160),
      canal VARCHAR(30),
      contacto VARCHAR(255),
      fuente VARCHAR(255),
      estado VARCHAR(30) NOT NULL DEFAULT 'nuevo',
      notas TEXT,
      proxima_accion VARCHAR(255),
      fecha_proxima_accion TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS publicaciones_instagram (
      id BIGSERIAL PRIMARY KEY,
      image_url TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      scheduled_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'programada',
      instagram_media_id VARCHAR(100),
      error TEXT,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS imagenes_marketing (
      id BIGSERIAL PRIMARY KEY,
      prompt TEXT NOT NULL,
      model VARCHAR(100) NOT NULL,
      size VARCHAR(40) NOT NULL,
      quality VARCHAR(20) NOT NULL,
      mime_type VARCHAR(80) NOT NULL DEFAULT 'image/png',
      image_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE imagenes_marketing
    ADD COLUMN IF NOT EXISTS background_data BYTEA,
    ADD COLUMN IF NOT EXISTS copy_fields JSONB,
    ADD COLUMN IF NOT EXISTS parent_image_id BIGINT REFERENCES imagenes_marketing(id)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS imagen_operaciones (
    request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL,
    resultado JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await migrate(pool);
  await migrateMedia(pool);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prospectos_estado
    ON prospectos_sismed (estado)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_publicaciones_estado_fecha
    ON publicaciones_instagram (status, scheduled_at)
  `);
}

function auth(req, res, next) {
  const header = req.get("authorization") || "";
  if (header !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

async function igRequest(path, { method = "GET", params = {} } = {}) {
  requireInstagram();

  const url = new URL(`${IG_BASE}${path}`);
  const options = { method, headers: {} };

  if (method === "GET") {
    const allParams = { ...params, access_token: IG_TOKEN };
    for (const [key, value] of Object.entries(allParams)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  } else {
    const body = new URLSearchParams();
    const allParams = { ...params, access_token: IG_TOKEN };

    for (const [key, value] of Object.entries(allParams)) {
      if (value !== undefined && value !== null) {
        body.set(key, String(value));
      }
    }

    options.headers["Content-Type"] =
      "application/x-www-form-urlencoded";
    options.body = body;
  }

  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(25000) });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    const message =
      data?.error?.message || `Instagram API HTTP ${response.status}`;

    const err = new Error(message);
    err.meta = data?.error || data;
    throw err;
  }

  return data;
}

function requireCloudflareAI() {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    const err = new Error(
      "Faltan CLOUDFLARE_ACCOUNT_ID o CLOUDFLARE_API_TOKEN en Render"
    );
    err.status = 503;
    throw err;
  }
}

function premiumSteps(quality) {
  if (quality === "high") return 18;
  if (quality === "medium") return 14;
  if (quality === "low") return 10;
  return 14;
}

function normalizeGenerationMode(mode) {
  return mode === "premium" ? "premium" : "economy";
}

async function generateMarketingImage({
  prompt,
  size = "1024x1280",
  quality = "medium",
  mode = "economy",
  title = "Organizá tu consultorio con Sismed",
  subtitle = "",
  bullets = [],
  cta = "Escribinos por privado"
}) {
  requireCloudflareAI();
  if (!["economy", "premium"].includes(mode)) throw Object.assign(new Error("mode inválido"), {status:400});
  if (size !== "1024x1280") throw Object.assign(new Error("Solo se admite 1024x1280"), {status:400});
  await prepareLayout({ title, subtitle, bullets, cta });

  const allowedQualities = new Set(["low", "medium", "high", "auto"]);
  if (!allowedQualities.has(quality)) {
    throw new Error("quality inválida");
  }

  if (!prompt || prompt.length > 2048) {
    throw new Error(
      "El prompt debe tener entre 1 y 2048 caracteres para Cloudflare Workers AI"
    );
  }

  // Cloudflare espera el modelo literalmente en la ruta:
  // /ai/run/@cf/black-forest-labs/flux-1-schnell
  const generationMode = normalizeGenerationMode(mode);
  const selectedModel =
    generationMode === "premium"
      ? CLOUDFLARE_IMAGE_MODEL_PREMIUM
      : CLOUDFLARE_IMAGE_MODEL_FAST;

  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${encodeURIComponent(CLOUDFLARE_ACCOUNT_ID)}/ai/run/` +
    `${selectedModel}`;

  const backgroundPrompt =
    `${prompt}. Professional medical technology advertising background. ` +
    `IMPORTANT: generate only the visual background and scene. ` +
    `Do not include any text, letters, words, logos, captions, UI labels, signs or typography. ` +
    `Keep the subject mainly on the right side. Leave the left side visually simple.`;

  const requestBody =
    generationMode === "premium"
      ? {
          prompt: backgroundPrompt,
          width: 1024,
          height: 1280,
          guidance: 5.5,
          num_steps: premiumSteps(quality)
        }
      : {
          prompt: backgroundPrompt,
          steps: 4
        };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(90000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.success === false) {
    const apiMessage =
      data?.errors?.[0]?.message ||
      data?.error?.message ||
      `Cloudflare Workers AI HTTP ${response.status}`;

    const err = new Error(apiMessage);
    err.status = response.status;
    err.meta = data;
    throw err;
  }

  // Cloudflare's REST API normally wraps the model output in `result`.
  // Lucid Origin returns an `image` field containing Base64 image data.
  const result = data?.result ?? data;
  const b64 =
    result?.image ||
    data?.image ||
    result?.response?.image;

  if (!b64 || typeof b64 !== "string") {
    const err = new Error(
      "Cloudflare no devolvió la imagen esperada en Base64"
    );
    err.meta = data;
    throw err;
  }

  const rawBuffer = Buffer.from(b64, "base64");

  const finalBuffer = await applySismedOverlay(rawBuffer, {
    title,
    subtitle,
    bullets,
    cta
  });

  const saved = await pool.query(
    `
    INSERT INTO imagenes_marketing
      (prompt, model, size, quality, mime_type, image_data, background_data, copy_fields)
    VALUES ($1,$2,$3,$4,'image/jpeg',$5,$6,$7)
    RETURNING id, prompt, model, size, quality, mime_type, created_at
    `,
    [prompt, selectedModel, "1024x1280", quality, finalBuffer, rawBuffer, JSON.stringify({title,subtitle,bullets,cta})]
  );

  const image = saved.rows[0];

  return {
    ...image,
    provider: "cloudflare-workers-ai",
    mode: generationMode,
    model: selectedModel,
    url: `${PUBLIC_BASE_URL}/media/generated/${image.id}.jpg`
  };
}

/* ---------- RUTAS PÚBLICAS ---------- */


app.get("/media/generated/:file", async (req, res) => {
  try {
    const match = String(req.params.file || "").match(/^(\d+)\.(?:png|jpg|jpeg)$/i);
    const id = match ? Number(match[1]) : NaN;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).send("ID inválido");
    }

    const result = await pool.query(
      `
      SELECT mime_type, image_data
      FROM imagenes_marketing
      WHERE id = $1
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).send("Imagen no encontrada");
    }

    const item = result.rows[0];
    if(!item.image_data)return res.status(410).send("Archivo archivado tras su publicación");

    res.set("Content-Type", item.mime_type || "image/png");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(item.image_data);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error interno");
  }
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Sismed Marketing IA",
    version: "3.6.0"
  });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      service: "sismed-marketing-action",
      version: "3.6.0"
    });
  } catch (error) {
    console.error(error);
    res.status(503).json({ ok: false });
  }
});

app.get("/privacy", (_req, res) => {
  res.type("html").send(`
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Privacidad - Sismed Marketing IA</title>
</head>
<body style="font-family:Arial;max-width:780px;margin:40px auto;padding:0 20px;line-height:1.55">
<h1>Política de privacidad - Sismed Marketing IA</h1>
<p>Esta API gestiona contactos comerciales y publicaciones de marketing de Sismed.</p>
<p>No debe almacenar historias clínicas, diagnósticos, datos de pacientes ni información médica sensible.</p>
<p>Los tokens y credenciales se almacenan como variables secretas del servicio y no se exponen mediante la API.</p>
</body>
</html>
  `);
});

/* ---------- RUTAS PROTEGIDAS ---------- */

app.use("/api", auth);

/* ---------- PROSPECTOS ---------- */

app.post("/api/prospectos", async (req, res) => {
  try {
    const body = req.body || {};

    const nombre = clean(body.nombre_consultorio, 200);

    if (!nombre) {
      return res.status(400).json({
        error: "nombre_consultorio es obligatorio"
      });
    }

    const estado = clean(body.estado, 30) || "nuevo";
    const canal = clean(body.canal, 30);

    if (!ESTADOS.has(estado)) {
      return res.status(400).json({ error: "estado inválido" });
    }

    if (canal && !CANALES.has(canal)) {
      return res.status(400).json({ error: "canal inválido" });
    }

    const fecha = parseDate(body.fecha_proxima_accion);

    if (body.fecha_proxima_accion && fecha === undefined) {
      return res.status(400).json({ error: "fecha inválida" });
    }

    const result = await pool.query(
      `
      INSERT INTO prospectos_sismed
      (
        nombre_consultorio,
        ciudad,
        contacto_nombre,
        canal,
        contacto,
        fuente,
        estado,
        notas,
        proxima_accion,
        fecha_proxima_accion
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        nombre,
        clean(body.ciudad, 120),
        clean(body.contacto_nombre, 160),
        canal,
        clean(body.contacto, 255),
        clean(body.fuente, 255),
        estado,
        clean(body.notas, 4000),
        clean(body.proxima_accion, 255),
        fecha
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno" });
  }
});

app.get("/api/prospectos", async (req, res) => {
  try {
    const estado = clean(req.query.estado, 30);
    const limite = Math.min(
      Math.max(Number(req.query.limite || 25), 1),
      100
    );

    const params = [];
    let sql = "SELECT * FROM prospectos_sismed";

    if (estado) {
      if (!ESTADOS.has(estado)) {
        return res.status(400).json({ error: "estado inválido" });
      }

      params.push(estado);
      sql += " WHERE estado = $1";
    }

    params.push(limite);
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length}`;

    const result = await pool.query(sql, params);

    res.json({
      total: result.rows.length,
      prospectos: result.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno" });
  }
});

app.patch("/api/prospectos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "id inválido" });
    }

    const allowed = {
      ciudad: [120, null],
      contacto_nombre: [160, null],
      canal: [30, "canal"],
      contacto: [255, null],
      fuente: [255, null],
      estado: [30, "estado"],
      notas: [4000, null],
      proxima_accion: [255, null],
      fecha_proxima_accion: [null, "fecha"]
    };

    const sets = [];
    const values = [];
    let index = 1;

    for (const [key, config] of Object.entries(allowed)) {
      if (!(key in req.body)) continue;

      let value;

      if (config[1] === "fecha") {
        value = parseDate(req.body[key]);

        if (req.body[key] && value === undefined) {
          return res.status(400).json({
            error: "fecha inválida"
          });
        }
      } else {
        value = clean(req.body[key], config[0]);
      }

      if (
        config[1] === "estado" &&
        value &&
        !ESTADOS.has(value)
      ) {
        return res.status(400).json({
          error: "estado inválido"
        });
      }

      if (
        config[1] === "canal" &&
        value &&
        !CANALES.has(value)
      ) {
        return res.status(400).json({
          error: "canal inválido"
        });
      }

      sets.push(`${key} = $${index++}`);
      values.push(value);
    }

    if (!sets.length) {
      return res.status(400).json({
        error: "No hay campos válidos"
      });
    }

    sets.push("updated_at = NOW()");
    values.push(id);

    const result = await pool.query(
      `
      UPDATE prospectos_sismed
      SET ${sets.join(", ")}
      WHERE id = $${index}
      RETURNING *
      `,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Prospecto no encontrado"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno" });
  }
});


/* ---------- IMÁGENES DE MARKETING ---------- */

// Persist one generation attempt per request_id. An uncertain retry cannot consume twice.
async function imageOperation(req, res, operation, payload, execute) {
  const requestId = req.body?.request_id;
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) {
    return res.status(400).json({error:"request_id obligatorio: 16 a 100 letras, números o guiones"});
  }
  const hash = createHash("sha256").update(JSON.stringify([operation,payload])).digest("hex");
  const claim = await pool.query(`INSERT INTO imagen_operaciones(request_id,request_hash,status)
    VALUES ($1,$2,'procesando') ON CONFLICT DO NOTHING RETURNING request_id`,[requestId,hash]);
  if (!claim.rows.length) {
    const item = (await pool.query("SELECT * FROM imagen_operaciones WHERE request_id=$1",[requestId])).rows[0];
    if (item.request_hash !== hash) return res.status(409).json({error:"request_id ya usado con otros datos"});
    if (item.status === 'lista') return res.json({ok:true,imagen:item.resultado,reutilizada:true});
    return res.status(409).json({error:"Intento previo pendiente o fallido: revisar imágenes antes de generar otra vez",status:item.status});
  }
  try {
    const image = await execute();
    await pool.query("UPDATE imagen_operaciones SET status='lista',resultado=$2 WHERE request_id=$1",[requestId,JSON.stringify(image)]);
    res.status(201).json({ok:true,imagen:image});
  } catch(error) {
    await pool.query("UPDATE imagen_operaciones SET status='revision' WHERE request_id=$1",[requestId]);
    res.status(error.status >= 400 && error.status < 500 ? error.status : 502).json({error: error.status === 422 || error.status === 400 ? error.message : "No se completó la imagen. Revisar cuota, configuración y registros antes de reintentar."});
  }
}
app.post("/api/imagenes/generar", async (req,res) => {
  try {
    const copy = validateCopy(req.body || {});
    const {prompt,mode='economy',quality='medium',size='1024x1280'} = req.body;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2048) return res.status(400).json({error:'prompt inválido'});
    if (!['economy','premium'].includes(mode) || !['low','medium','high','auto'].includes(quality) || size!=='1024x1280') return res.status(400).json({error:'Modo, calidad o tamaño inválido'});
    const payload={prompt,mode,quality,size,...copy};
    await imageOperation(req,res,'generar',payload,()=>generateMarketingImage(payload));
  } catch(error) {res.status(error.status || 500).json({error:error.status?error.message:'Error interno'});}
});
app.post("/api/imagenes/:id/textos", async (req,res) => {
  try {
    const id=Number(req.params.id);
    if (!Number.isSafeInteger(id)||id<1) return res.status(400).json({error:'id inválido'});
    const copy=validateCopy(req.body||{});
    const existing=(await pool.query('SELECT * FROM imagenes_marketing WHERE id=$1',[id])).rows[0];
    if (!existing) return res.status(404).json({error:'Imagen no encontrada'});
    if (!existing.background_data) return res.status(409).json({error:'Esta imagen antigua no conserva el fondo. Solo las nuevas permiten editar textos.'});
    await imageOperation(req,res,'textos',{id,...copy},async()=>{
      const finalBuffer=await applySismedOverlay(existing.background_data,copy);
      const saved=await pool.query(`INSERT INTO imagenes_marketing
        (prompt,model,size,quality,mime_type,image_data,background_data,copy_fields,parent_image_id)
        VALUES ($1,$2,'1024x1280',$3,'image/jpeg',$4,$5,$6,$7)
        RETURNING id,prompt,model,size,quality,mime_type,created_at`,
        [existing.prompt,existing.model,existing.quality,finalBuffer,existing.background_data,JSON.stringify(copy),id]);
      const item=saved.rows[0];
      return {...item,url:`${PUBLIC_BASE_URL}/media/generated/${item.id}.jpg`};
    });
  } catch(error) {res.status(error.status||500).json({error:error.status?error.message:'Error interno'});}
});

app.get("/api/imagenes", async (req, res) => {
  try {
    const limite = Math.min(
      Math.max(Number(req.query.limite || 20), 1),
      100
    );

    const result = await pool.query(
      `
      SELECT id, prompt, model, size, quality, mime_type, created_at, purged_at
      FROM imagenes_marketing
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limite]
    );

    res.json({
      total: result.rows.length,
      imagenes: result.rows.map((item) => ({
        ...item,
        url: item.purged_at ? null : `${PUBLIC_BASE_URL}/media/generated/${item.id}.jpg`
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno" });
  }
});

/* ---------- INSTAGRAM ---------- */

app.get("/api/instagram/status", async (_req, res) => {
  try {
    requireInstagram();

    const data = await igRequest(`/${IG_ACCOUNT_ID}`, {
      params: {
        fields: "id,username,account_type"
      }
    });

    res.json({
      conectado: true,
      api_version: IG_VERSION,
      cuenta: data
    });
  } catch (error) {
    console.error(error);

    res.status(error.status || 502).json({
      conectado: false,
      error: error.message,
      detalle: error.meta || null
    });
  }
});

const reels=createReels({pool,publicBaseUrl:PUBLIC_BASE_URL});
const reelRoute=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Error interno'});}};
app.post('/api/reels',reelRoute(req=>reels.create(req.body||{})));
app.get('/api/reels/:id',reelRoute(req=>reels.get(req.params.id)));
// Public MP4 endpoint with range support for preview and Meta downloads.
app.get('/media/reels/:id.mp4',async(req,res)=>{
 try{
 if(!/^\d+$/.test(req.params.id))return res.sendStatus(400);
 const r=await pool.query('SELECT video_data,purged_at FROM reels_marketing WHERE id=$1',[req.params.id]);
 if(!r.rows.length)return res.sendStatus(404);if(!r.rows[0].video_data)return res.sendStatus(r.rows[0].purged_at?410:404);
 const data=r.rows[0].video_data;res.set({'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600'});
 if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m)return res.status(416).set('Content-Range',`bytes */${data.length}`).end();
 const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),data.length-1):data.length-1;
 if(start>end||start>=data.length)return res.status(416).set('Content-Range',`bytes */${data.length}`).end();
 return res.status(206).set('Content-Range',`bytes ${start}-${end}/${data.length}`).send(data.subarray(start,end+1));}
 res.send(data);
 }catch(_){res.sendStatus(500);}
});
registerRoutes(app, { pool, igRequest, accountId: IG_ACCOUNT_ID, publicBaseUrl: PUBLIC_BASE_URL });

if (require.main === module) init()
  .then(() => {
    setInterval(()=>reels.process().catch(()=>console.error('Fallo procesando reel')),15000).unref();
    setInterval(()=>cleanup(pool).catch(()=>console.error('Fallo de limpieza de medios')),3600000).unref();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Sismed Action v3.6 listening on ${PORT}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

module.exports = { app, init, pool };
