require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const { Pool } = require("pg");

const app = express();
app.use(helmet());
app.use(express.json({ limit: "200kb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.ACTION_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const IG_VERSION = process.env.INSTAGRAM_API_VERSION || "v26.0";
const IG_BASE = `https://graph.instagram.com/${IG_VERSION}`;

if (!API_KEY || !DATABASE_URL) {
  console.error("Faltan ACTION_API_KEY o DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const ESTADOS = new Set(["nuevo","contactado","respondio","interesado","piloto","descartado"]);
const CANALES = new Set(["instagram","facebook","whatsapp","email","telefono","linkedin","web","visita","otro"]);

const clean = (v, max=255) =>
  (v === undefined || v === null || v === "") ? null : String(v).trim().slice(0, max);

const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

function requireInstagram() {
  if (!IG_TOKEN || !IG_ACCOUNT_ID) {
    const err = new Error("Faltan INSTAGRAM_ACCESS_TOKEN o INSTAGRAM_ACCOUNT_ID en Render");
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

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prospectos_estado ON prospectos_sismed (estado)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_publicaciones_estado_fecha ON publicaciones_instagram (status, scheduled_at)`);
}

function auth(req,res,next){
  if ((req.get("authorization") || "") !== `Bearer ${API_KEY}`) {
    return res.status(401).json({error:"No autorizado"});
  }
  next();
}

async function igRequest(path, { method="GET", params={} } = {}) {
  requireInstagram();
  const url = new URL(`${IG_BASE}${path}`);
  const options = { method, headers: {} };

  if (method === "GET") {
    for (const [k,v] of Object.entries({...params, access_token: IG_TOKEN})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  } else {
    const body = new URLSearchParams();
    for (const [k,v] of Object.entries({...params, access_token: IG_TOKEN})) {
      if (v !== undefined && v !== null) body.set(k, String(v));
    }
    options.headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = body;
  }

  const r = await fetch(url, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const msg = data?.error?.message || `Instagram API HTTP ${r.status}`;
    const e = new Error(msg);
    e.meta = data?.error || data;
    throw e;
  }
  return data;
}

async function waitForContainer(containerId) {
  for (let i = 0; i < 8; i++) {
    const s = await igRequest(`/${containerId}`, {
      params: { fields: "status_code,status" }
    });
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return s;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
      throw new Error(`Contenedor de Instagram: ${s.status_code}${s.status ? " - "+s.status : ""}`);
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error("Instagram todavía está procesando el contenido. Intentá nuevamente en unos segundos.");
}

async function publishImage(imageUrl, caption="") {
  requireInstagram();
  if (!/^https:\/\//i.test(imageUrl)) throw new Error("image_url debe ser una URL pública HTTPS");

  const container = await igRequest(`/${IG_ACCOUNT_ID}/media`, {
    method: "POST",
    params: { image_url: imageUrl, caption: caption || "" }
  });

  await waitForContainer(container.id);

  const published = await igRequest(`/${IG_ACCOUNT_ID}/media_publish`, {
    method: "POST",
    params: { creation_id: container.id }
  });

  return { container_id: container.id, media_id: published.id };
}

app.get("/", (_req,res) => res.json({ok:true,service:"Sismed Marketing IA",version:"2.0.0"}));

app.get("/health", async (_req,res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ok:true,service:"sismed-marketing-action",version:"2.0.0"});
  } catch (e) {
    console.error(e);
    res.status(503).json({ok:false});
  }
});

app.get("/privacy", (_req,res) => {
  res.type("html").send(`<!doctype html><html lang="es"><meta charset="utf-8">
  <title>Privacidad - Sismed Marketing IA</title>
  <body style="font-family:Arial;max-width:780px;margin:40px auto;padding:0 20px;line-height:1.55">
  <h1>Política de privacidad - Sismed Marketing IA</h1>
  <p>Esta API gestiona contactos comerciales y publicaciones de marketing de Sismed.</p>
  <p>No debe almacenar historias clínicas, diagnósticos, datos de pacientes ni información médica sensible.</p>
  <p>Los tokens y credenciales se almacenan como variables secretas del servicio y no se exponen mediante la API.</p>
  </body></html>`);
});

app.use("/api", auth);
/* ---------- PROSPECTOS ---------- */

app.post("/api/prospectos", async (req,res) => {
  try {
    const b = req.body || {};
    const nombre = clean(b.nombre_consultorio,200);
    if (!nombre) return res.status(400).json({error:"nombre_consultorio es obligatorio"});
    const estado = clean(b.estado,30) || "nuevo";
    const canal = clean(b.canal,30);
    if (!ESTADOS.has(estado)) return res.status(400).json({error:"estado inválido"});
    if (canal && !CANALES.has(canal)) return res.status(400).json({error:"canal inválido"});
    const f = parseDate(b.fecha_proxima_accion);
    if (b.fecha_proxima_accion && f === undefined) return res.status(400).json({error:"fecha inválida"});

    const r = await pool.query(
      `INSERT INTO prospectos_sismed
      (nombre_consultorio,ciudad,contacto_nombre,canal,contacto,fuente,estado,notas,proxima_accion,fecha_proxima_accion)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [nombre,clean(b.ciudad,120),clean(b.contacto_nombre,160),canal,clean(b.contacto,255),
       clean(b.fuente,255),estado,clean(b.notas,4000),clean(b.proxima_accion,255),f]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({error:"Error interno"});
  }
});

app.get("/api/prospectos", async (req,res) => {
  try {
    const estado = clean(req.query.estado,30);
    const limite = Math.min(Math.max(Number(req.query.limite || 25),1),100);
    const params = [];
    let sql = "SELECT * FROM prospectos_sismed";
    if (estado) {
      if (!ESTADOS.has(estado)) return res.status(400).json({error:"estado inválido"});
      params.push(estado);
      sql += " WHERE estado = $1";
    }
    params.push(limite);
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length}`;
    const r = await pool.query(sql,params);
    res.json({total:r.rows.length,prospectos:r.rows});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:"Error interno"});
  }
});

app.patch("/api/prospectos/:id", async (req,res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({error:"id inválido"});

    const allowed = {
      ciudad:[120,null], contacto_nombre:[160,null], canal:[30,"canal"], contacto:[255,null],
      fuente:[255,null], estado:[30,"estado"], notas:[4000,null], proxima_accion:[255,null],
      fecha_proxima_accion:[null,"fecha"]
    };

    const sets = [], values = [];
    let n = 1;
    for (const [k,cfg] of Object.entries(allowed)) {
      if (!(k in req.body)) continue;
      let v = cfg[1] === "fecha" ? parseDate(req.body[k]) : clean(req.body[k],cfg[0]);
      if (cfg[1] === "fecha" && req.body[k] && v === undefined) return res.status(400).json({error:"fecha inválida"});
      if (cfg[1] === "estado" && v && !ESTADOS.has(v)) return res.status(400).json({error:"estado inválido"});
      if (cfg[1] === "canal" && v && !CANALES.has(v)) return res.status(400).json({error:"canal inválido"});
      sets.push(`${k} = $${n++}`);
      values.push(v);
    }

    if (!sets.length) return res.status(400).json({error:"No hay campos válidos"});
    sets.push("updated_at = NOW()");
    values.push(id);

    const r = await pool.query(
      `UPDATE prospectos_sismed SET ${sets.join(", ")} WHERE id = $${n} RETURNING *`,
      values
    );
    if (!r.rows.length) return res.status(404).json({error:"Prospecto no encontrado"});
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({error:"Error interno"});
  }
});

/* ---------- INSTAGRAM ---------- */

app.get("/api/instagram/status", async (_req,res) => {
  try {
    requireInstagram();
    const data = await igRequest(`/${IG_ACCOUNT_ID}`, {
      params: { fields: "id,username,account_type" }
    });
    res.json({conectado:true,api_version:IG_VERSION,cuenta:data});
  } catch (e) {
    console.error(e);
    res.status(e.status || 502).json({conectado:false,error:e.message,detalle:e.meta || null});
  }
});

app.post("/api/instagram/publicar-imagen", async (req,res) => {
  try {
    const imageUrl = clean(req.body?.image_url, 2000);
    const caption = clean(req.body?.caption, 2200) || "";
    if (!imageUrl) return res.status(400).json({error:"image_url es obligatorio"});

    const pub = await publishImage(imageUrl, caption);

    const r = await pool.query(
      `INSERT INTO publicaciones_instagram
       (image_url,caption,scheduled_at,status,instagram_media_id,published_at)
       VALUES ($1,$2,NOW(),'publicada',$3,NOW()) RETURNING *`,
      [imageUrl,caption,pub.media_id]
    );

    res.status(201).json({ok:true,instagram:pub,registro:r.rows[0]});
  } catch (e) {
    console.error(e);
    res.status(502).json({error:e.message,detalle:e.meta || null});
  }
});

app.post("/api/instagram/programaciones", async (req,res) => {
  try {
    const imageUrl = clean(req.body?.image_url, 2000);
    const caption = clean(req.body?.caption, 2200) || "";
    const scheduledAt = parseDate(req.body?.scheduled_at);

    if (!imageUrl) return res.status(400).json({error:"image_url es obligatorio"});
    if (!/^https:\/\//i.test(imageUrl)) return res.status(400).json({error:"image_url debe ser HTTPS público"});
    if (!scheduledAt) return res.status(400).json({error:"scheduled_at es obligatorio y debe ser una fecha válida"});

    const r = await pool.query(
      `INSERT INTO publicaciones_instagram
       (image_url,caption,scheduled_at,status)
       VALUES ($1,$2,$3,'programada') RETURNING *`,
      [imageUrl,caption,scheduledAt]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({error:"Error interno"});
  }
});

app.get("/api/instagram/programaciones", async (req,res) => {
  try {
    const status = clean(req.query.status,30);
    const limite = Math.min(Math.max(Number(req.query.limite || 25),1),100);
    const params = [];
    let sql = "SELECT * FROM publicaciones_instagram";
    if (status) {
      params.push(status);
      sql += " WHERE status = $1";
    }
    params.push(limite);
    sql += ` ORDER BY scheduled_at ASC LIMIT $${params.length}`;
    const r = await pool.query(sql,params);
    res.json({total:r.rows.length,publicaciones:r.rows});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:"Error interno"});
  }
});

app.post("/api/instagram/programaciones/:id/publicar", async (req,res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({error:"id inválido"});

    const q = await pool.query(`SELECT * FROM publicaciones_instagram WHERE id=$1`,[id]);
    if (!q.rows.length) return res.status(404).json({error:"Publicación no encontrada"});
    const item = q.rows[0];
    if (item.status === "publicada") return res.json({ok:true,ya_publicada:true,publicacion:item});

    const pub = await publishImage(item.image_url,item.caption);
    const r = await pool.query(
      `UPDATE publicaciones_instagram
       SET status='publicada',instagram_media_id=$2,published_at=NOW(),error=NULL,updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id,pub.media_id]
    );
    res.json({ok:true,instagram:pub,publicacion:r.rows[0]});
  } catch (e) {
    console.error(e);
    res.status(502).json({error:e.message,detalle:e.meta || null});
  }
});

app.post("/api/instagram/procesar-programadas", async (_req,res) => {
  const resultados = [];
  try {
    const due = await pool.query(
      `SELECT id FROM publicaciones_instagram
       WHERE status='programada' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT 10`
    );

    for (const row of due.rows) {
      const id = row.id;
      const claim = await pool.query(
        `UPDATE publicaciones_instagram
         SET status='procesando',updated_at=NOW()
         WHERE id=$1 AND status='programada'
         RETURNING *`,
        [id]
      );
      if (!claim.rows.length) continue;

      const item = claim.rows[0];
      try {
        const pub = await publishImage(item.image_url,item.caption);
        const saved = await pool.query(
          `UPDATE publicaciones_instagram
           SET status='publicada',instagram_media_id=$2,published_at=NOW(),error=NULL,updated_at=NOW()
           WHERE id=$1 RETURNING *`,
          [id,pub.media_id]
        );
        resultados.push({id,ok:true,media_id:pub.media_id,registro:saved.rows[0]});
      } catch (e) {
        await pool.query(
          `UPDATE publicaciones_instagram
           SET status='error',error=$2,updated_at=NOW()
           WHERE id=$1`,
          [id,String(e.message).slice(0,4000)]
        );
        resultados.push({id,ok:false,error:e.message});
      }
    }

    res.json({ok:true,procesadas:resultados.length,resultados});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:"Error procesando programaciones"});
  }
});

init()
  .then(() => app.listen(PORT,"0.0.0.0",() => console.log(`Sismed Action v2 listening on ${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
