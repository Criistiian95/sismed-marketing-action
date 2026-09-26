require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const mysql = require("mysql2/promise");

const app = express();
app.use(helmet());
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ACTION_API_KEY;
if (!API_KEY) throw new Error("Falta ACTION_API_KEY");

const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
const pool = dbUrl ? mysql.createPool(dbUrl) : mysql.createPool({
  host: process.env.MYSQLHOST,
  port: Number(process.env.MYSQLPORT || 3306),
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  waitForConnections: true,
  connectionLimit: 5
});

const ESTADOS = new Set(["nuevo","contactado","respondio","interesado","piloto","descartado"]);
const CANALES = new Set(["instagram","facebook","whatsapp","email","telefono","linkedin","web","visita","otro"]);

const txt = (v, max=255) => (v === undefined || v === null || v === "") ? null : String(v).trim().slice(0,max);
const fecha = (v) => {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0,19).replace("T"," ");
};

async function init() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS prospectos_sismed (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      nombre_consultorio VARCHAR(200) NOT NULL,
      ciudad VARCHAR(120) NULL,
      contacto_nombre VARCHAR(160) NULL,
      canal VARCHAR(30) NULL,
      contacto VARCHAR(255) NULL,
      fuente VARCHAR(255) NULL,
      estado VARCHAR(30) NOT NULL DEFAULT 'nuevo',
      notas TEXT NULL,
      proxima_accion VARCHAR(255) NULL,
      fecha_proxima_accion DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_estado (estado),
      INDEX idx_fecha_proxima_accion (fecha_proxima_accion)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function auth(req,res,next){
  if ((req.get("authorization") || "") !== `Bearer ${API_KEY}`)
    return res.status(401).json({error:"No autorizado"});
  next();
}

app.get("/health", async (_req,res) => {
  try { await pool.query("SELECT 1"); res.json({ok:true,service:"sismed-prospectos-action"}); }
  catch { res.status(503).json({ok:false}); }
});

app.get("/privacy", (_req,res) => {
  res.type("html").send(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Privacidad - Sismed</title>
  <body style="font-family:Arial;max-width:760px;margin:40px auto;line-height:1.5">
  <h1>Política de privacidad - Sismed Marketing IA</h1>
  <p>Esta API registra únicamente contactos comerciales de consultorios para la captación de Sismed.</p>
  <p>Puede guardar nombre del consultorio, ciudad, contacto comercial, canal, fuente, estado, notas y próxima acción.</p>
  <p><strong>No debe almacenar historias clínicas, diagnósticos, datos de pacientes ni información médica sensible.</strong></p>
  <p>Los datos se conservan en la base configurada por el responsable de Sismed.</p></body></html>`);
});

app.use("/api", auth);

app.post("/api/prospectos", async (req,res) => {
  try {
    const b = req.body || {};
    const nombre = txt(b.nombre_consultorio,200);
    if (!nombre) return res.status(400).json({error:"nombre_consultorio es obligatorio"});
    const estado = txt(b.estado,30) || "nuevo";
    const canal = txt(b.canal,30);
    if (!ESTADOS.has(estado)) return res.status(400).json({error:"estado inválido"});
    if (canal && !CANALES.has(canal)) return res.status(400).json({error:"canal inválido"});
    const f = fecha(b.fecha_proxima_accion);
    if (b.fecha_proxima_accion && f === undefined) return res.status(400).json({error:"fecha inválida"});

    const vals = [nombre,txt(b.ciudad,120),txt(b.contacto_nombre,160),canal,txt(b.contacto,255),
      txt(b.fuente,255),estado,txt(b.notas,4000),txt(b.proxima_accion,255),f];
    const [r] = await pool.execute(
      `INSERT INTO prospectos_sismed
      (nombre_consultorio,ciudad,contacto_nombre,canal,contacto,fuente,estado,notas,proxima_accion,fecha_proxima_accion)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, vals);
    const [rows] = await pool.execute("SELECT * FROM prospectos_sismed WHERE id=?",[r.insertId]);
    res.status(201).json(rows[0]);
  } catch(e){ console.error(e); res.status(500).json({error:"Error interno"}); }
});

app.get("/api/prospectos", async (req,res) => {
  try {
    const estado = txt(req.query.estado,30);
    const limite = Math.min(Math.max(Number(req.query.limite || 25),1),100);
    let sql = "SELECT * FROM prospectos_sismed";
    const p = [];
    if (estado) {
      if (!ESTADOS.has(estado)) return res.status(400).json({error:"estado inválido"});
      sql += " WHERE estado=?";
      p.push(estado);
    }
    sql += " ORDER BY updated_at DESC LIMIT ?";
    p.push(limite);
    const [rows] = await pool.execute(sql,p);
    res.json({total:rows.length,prospectos:rows});
  } catch(e){ console.error(e); res.status(500).json({error:"Error interno"}); }
});

app.patch("/api/prospectos/:id", async (req,res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({error:"id inválido"});
    const map = {
      ciudad:[120], contacto_nombre:[160], canal:[30,"canal"], contacto:[255], fuente:[255],
      estado:[30,"estado"], notas:[4000], proxima_accion:[255], fecha_proxima_accion:[null,"fecha"]
    };
    const sets=[], p=[];
    for (const [k,cfg] of Object.entries(map)) {
      if (!(k in req.body)) continue;
      let v = cfg[1] === "fecha" ? fecha(req.body[k]) : txt(req.body[k],cfg[0]);
      if (cfg[1] === "fecha" && req.body[k] && v === undefined) return res.status(400).json({error:"fecha inválida"});
      if (cfg[1] === "estado" && v && !ESTADOS.has(v)) return res.status(400).json({error:"estado inválido"});
      if (cfg[1] === "canal" && v && !CANALES.has(v)) return res.status(400).json({error:"canal inválido"});
      sets.push(`${k}=?`); p.push(v);
    }
    if (!sets.length) return res.status(400).json({error:"No hay campos válidos"});
    p.push(id);
    const [r] = await pool.execute(`UPDATE prospectos_sismed SET ${sets.join(",")} WHERE id=?`,p);
    if (!r.affectedRows) return res.status(404).json({error:"Prospecto no encontrado"});
    const [rows] = await pool.execute("SELECT * FROM prospectos_sismed WHERE id=?",[id]);
    res.json(rows[0]);
  } catch(e){ console.error(e); res.status(500).json({error:"Error interno"}); }
});

init().then(() => app.listen(PORT,"0.0.0.0",() => console.log(`Listening on ${PORT}`)))
.catch(e => { console.error(e); process.exit(1); });
