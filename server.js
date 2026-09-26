require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const { Pool } = require("pg");

const app = express();
app.use(helmet());
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.ACTION_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY || !DATABASE_URL) {
  console.error("Faltan ACTION_API_KEY o DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const ESTADOS = new Set(["nuevo","contactado","respondio","interesado","piloto","descartado"]);
const CANALES = new Set(["instagram","facebook","whatsapp","email","telefono","linkedin","web","visita","otro"]);

const clean = (v, max=255) => (v === undefined || v === null || v === "") ? null : String(v).trim().slice(0,max);
const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prospectos_estado ON prospectos_sismed (estado)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prospectos_fecha ON prospectos_sismed (fecha_proxima_accion)`);
}

function auth(req,res,next){
  if ((req.get("authorization") || "") !== `Bearer ${API_KEY}`) return res.status(401).json({error:"No autorizado"});
  next();
}

app.get("/", (_req,res) => res.json({ok:true,service:"Sismed Marketing IA - Prospectos"}));

app.get("/health", async (_req,res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ok:true,service:"sismed-marketing-action"});
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
  <p>Esta API gestiona únicamente contactos comerciales de consultorios vinculados a la captación de Sismed.</p>
  <p>Puede almacenar nombre del consultorio, ciudad, contacto comercial, canal, fuente, estado, notas y próxima acción.</p>
  <p><strong>No debe almacenar historias clínicas, diagnósticos, datos de pacientes ni información médica sensible.</strong></p>
  </body></html>`);
});

app.use("/api", auth);

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

init()
  .then(() => app.listen(PORT,"0.0.0.0",() => console.log(`Listening on ${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
