require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const { Pool } = require("pg");

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
const CLOUDFLARE_IMAGE_MODEL =
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

  const response = await fetch(url, options);
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

async function waitForContainer(containerId) {
  for (let i = 0; i < 8; i++) {
    const status = await igRequest(`/${containerId}`, {
      params: { fields: "status_code,status" }
    });

    if (
      status.status_code === "FINISHED" ||
      status.status_code === "PUBLISHED"
    ) {
      return status;
    }

    if (
      status.status_code === "ERROR" ||
      status.status_code === "EXPIRED"
    ) {
      throw new Error(
        `Contenedor de Instagram: ${status.status_code}` +
        (status.status ? ` - ${status.status}` : "")
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  throw new Error(
    "Instagram todavía está procesando el contenido. Intentá nuevamente en unos segundos."
  );
}

async function publishImage(imageUrl, caption = "") {
  requireInstagram();

  if (!/^https:\/\//i.test(imageUrl)) {
    throw new Error("image_url debe ser una URL pública HTTPS");
  }

  const container = await igRequest(`/${IG_ACCOUNT_ID}/media`, {
    method: "POST",
    params: {
      image_url: imageUrl,
      caption: caption || ""
    }
  });

  await waitForContainer(container.id);

  const published = await igRequest(
    `/${IG_ACCOUNT_ID}/media_publish`,
    {
      method: "POST",
      params: {
        creation_id: container.id
      }
    }
  );

  return {
    container_id: container.id,
    media_id: published.id
  };
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

function qualityToSteps(quality) {
  if (quality === "high") return 32;
  if (quality === "medium") return 26;
  if (quality === "low") return 18;
  return 26;
}

function parseImageSize(size) {
  const match = String(size || "").match(/^(\d+)x(\d+)$/);
  if (!match) return { width: 1024, height: 1280 };

  const width = Math.min(Math.max(Number(match[1]), 512), 2500);
  const height = Math.min(Math.max(Number(match[2]), 512), 2500);

  return { width, height };
}

async function generateMarketingImage({
  prompt,
  size = "1024x1024",
  quality = "medium"
}) {
  requireCloudflareAI();

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
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${encodeURIComponent(CLOUDFLARE_ACCOUNT_ID)}/ai/run/` +
    `${CLOUDFLARE_IMAGE_MODEL}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      width: parseImageSize(size).width,
      height: parseImageSize(size).height,
      guidance: 5.5,
      num_steps: qualityToSteps(quality)
    })
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

  const buffer = Buffer.from(b64, "base64");

  const saved = await pool.query(
    `
    INSERT INTO imagenes_marketing
      (prompt, model, size, quality, mime_type, image_data)
    VALUES ($1,$2,$3,$4,'image/jpeg',$5)
    RETURNING id, prompt, model, size, quality, mime_type, created_at
    `,
    [prompt, CLOUDFLARE_IMAGE_MODEL, size, quality, buffer]
  );

  const image = saved.rows[0];

  return {
    ...image,
    provider: "cloudflare-workers-ai",
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
    version: "3.2.0"
  });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      service: "sismed-marketing-action",
      version: "3.2.0"
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

app.post("/api/imagenes/generar", async (req, res) => {
  try {
    const prompt = clean(req.body?.prompt, 2048);
    const size = clean(req.body?.size, 40) || "1024x1280";
    const quality = clean(req.body?.quality, 20) || "medium";

    if (!prompt) {
      return res.status(400).json({
        error: "prompt es obligatorio"
      });
    }

    const image = await generateMarketingImage({
      prompt,
      size,
      quality
    });

    res.status(201).json({
      ok: true,
      imagen: image
    });
  } catch (error) {
    console.error(error);
    res.status(error.status || 502).json({
      error: error.message,
      detalle: error.meta || null
    });
  }
});

app.get("/api/imagenes", async (req, res) => {
  try {
    const limite = Math.min(
      Math.max(Number(req.query.limite || 20), 1),
      100
    );

    const result = await pool.query(
      `
      SELECT id, prompt, model, size, quality, mime_type, created_at
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
        url: `${PUBLIC_BASE_URL}/media/generated/${item.id}.jpg`
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

app.post("/api/instagram/publicar-imagen", async (req, res) => {
  try {
    const imageUrl = clean(req.body?.image_url, 2000);
    const caption = clean(req.body?.caption, 2200) || "";

    if (!imageUrl) {
      return res.status(400).json({
        error: "image_url es obligatorio"
      });
    }

    const pub = await publishImage(imageUrl, caption);

    const result = await pool.query(
      `
      INSERT INTO publicaciones_instagram
      (
        image_url,
        caption,
        scheduled_at,
        status,
        instagram_media_id,
        published_at
      )
      VALUES ($1,$2,NOW(),'publicada',$3,NOW())
      RETURNING *
      `,
      [imageUrl, caption, pub.media_id]
    );

    res.status(201).json({
      ok: true,
      instagram: pub,
      registro: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(502).json({
      error: error.message,
      detalle: error.meta || null
    });
  }
});

app.post("/api/instagram/programaciones", async (req, res) => {
  try {
    const imageUrl = clean(req.body?.image_url, 2000);
    const caption = clean(req.body?.caption, 2200) || "";
    const scheduledAt = parseDate(req.body?.scheduled_at);

    if (!imageUrl) {
      return res.status(400).json({
        error: "image_url es obligatorio"
      });
    }

    if (!/^https:\/\//i.test(imageUrl)) {
      return res.status(400).json({
        error: "image_url debe ser HTTPS público"
      });
    }

    if (!scheduledAt) {
      return res.status(400).json({
        error: "scheduled_at es obligatorio y debe ser una fecha válida"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO publicaciones_instagram
      (
        image_url,
        caption,
        scheduled_at,
        status
      )
      VALUES ($1,$2,$3,'programada')
      RETURNING *
      `,
      [imageUrl, caption, scheduledAt]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno" });
  }
});

app.get("/api/instagram/programaciones", async (req, res) => {
  try {
    const status = clean(req.query.status, 30);

    const limite = Math.min(
      Math.max(Number(req.query.limite || 25), 1),
      100
    );

    const params = [];
    let sql = "SELECT * FROM publicaciones_instagram";

    if (status) {
      params.push(status);
      sql += " WHERE status = $1";
    }

    params.push(limite);

    sql += `
      ORDER BY scheduled_at ASC
      LIMIT $${params.length}
    `;

    const result = await pool.query(sql, params);

    res.json({
      total: result.rows.length,
      publicaciones: result.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post(
  "/api/instagram/programaciones/:id/publicar",
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "id inválido" });
      }

      const query = await pool.query(
        `
        SELECT *
        FROM publicaciones_instagram
        WHERE id = $1
        `,
        [id]
      );

      if (!query.rows.length) {
        return res.status(404).json({
          error: "Publicación no encontrada"
        });
      }

      const item = query.rows[0];

      if (item.status === "publicada") {
        return res.json({
          ok: true,
          ya_publicada: true,
          publicacion: item
        });
      }

      const pub = await publishImage(
        item.image_url,
        item.caption
      );

      const result = await pool.query(
        `
        UPDATE publicaciones_instagram
        SET
          status='publicada',
          instagram_media_id=$2,
          published_at=NOW(),
          error=NULL,
          updated_at=NOW()
        WHERE id=$1
        RETURNING *
        `,
        [id, pub.media_id]
      );

      res.json({
        ok: true,
        instagram: pub,
        publicacion: result.rows[0]
      });
    } catch (error) {
      console.error(error);

      res.status(502).json({
        error: error.message,
        detalle: error.meta || null
      });
    }
  }
);


app.post("/api/instagram/generar-y-programar", async (req, res) => {
  try {
    const prompt = clean(req.body?.prompt, 2048);
    const caption = clean(req.body?.caption, 2200) || "";
    const scheduledAt = parseDate(req.body?.scheduled_at);
    const size = clean(req.body?.size, 40) || "1024x1280";
    const quality = clean(req.body?.quality, 20) || "medium";

    if (!prompt) {
      return res.status(400).json({ error: "prompt es obligatorio" });
    }

    if (!scheduledAt) {
      return res.status(400).json({
        error: "scheduled_at es obligatorio y debe ser una fecha válida"
      });
    }

    const image = await generateMarketingImage({
      prompt,
      size,
      quality
    });

    const result = await pool.query(
      `
      INSERT INTO publicaciones_instagram
        (image_url, caption, scheduled_at, status)
      VALUES ($1,$2,$3,'programada')
      RETURNING *
      `,
      [image.url, caption, scheduledAt]
    );

    res.status(201).json({
      ok: true,
      imagen: image,
      programacion: result.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(error.status || 502).json({
      error: error.message,
      detalle: error.meta || null
    });
  }
});

app.post(
  "/api/instagram/procesar-programadas",
  async (_req, res) => {
    const resultados = [];

    try {
      const due = await pool.query(`
        SELECT id
        FROM publicaciones_instagram
        WHERE
          status='programada'
          AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT 10
      `);

      for (const row of due.rows) {
        const id = row.id;

        const claim = await pool.query(
          `
          UPDATE publicaciones_instagram
          SET
            status='procesando',
            updated_at=NOW()
          WHERE
            id=$1
            AND status='programada'
          RETURNING *
          `,
          [id]
        );

        if (!claim.rows.length) continue;

        const item = claim.rows[0];

        try {
          const pub = await publishImage(
            item.image_url,
            item.caption
          );

          const saved = await pool.query(
            `
            UPDATE publicaciones_instagram
            SET
              status='publicada',
              instagram_media_id=$2,
              published_at=NOW(),
              error=NULL,
              updated_at=NOW()
            WHERE id=$1
            RETURNING *
            `,
            [id, pub.media_id]
          );

          resultados.push({
            id,
            ok: true,
            media_id: pub.media_id,
            registro: saved.rows[0]
          });
        } catch (error) {
          await pool.query(
            `
            UPDATE publicaciones_instagram
            SET
              status='error',
              error=$2,
              updated_at=NOW()
            WHERE id=$1
            `,
            [id, String(error.message).slice(0, 4000)]
          );

          resultados.push({
            id,
            ok: false,
            error: error.message
          });
        }
      }

      res.json({
        ok: true,
        procesadas: resultados.length,
        resultados
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Error procesando programaciones"
      });
    }
  }
);

init()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Sismed Action v3.2 listening on ${PORT}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
