const { createHash } = require('node:crypto');

const STATES = ['borrador', 'aprobada', 'programada', 'procesando', 'publicando', 'publicada', 'revision', 'error', 'cancelada'];
function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }
function integer(value, name = 'id') {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw problem(`${name} inválido`);
  return Number(value);
}
function text(value, max, name) {
  if (typeof value !== 'string' || value.length > max) throw problem(`${name} debe ser texto de hasta ${max} caracteres`);
  return value.trim();
}
function futureDate(value, now = Date.now()) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) throw problem('La fecha debe incluir zona horaria');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now) throw problem('La fecha debe ser válida y futura');
  return date.toISOString();
}
function key(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) throw problem('request_id debe tener de 16 a 100 letras, números, guiones o guiones bajos');
  return value;
}

async function migrate(pool) {
  // Additive migration. Existing scheduled jobs remain authorized legacy work;
  // never describe this migration marker as a newly obtained human approval.
  await pool.query(`ALTER TABLE publicaciones_instagram
    ALTER COLUMN scheduled_at DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS image_id BIGINT REFERENCES imagenes_marketing(id),
    ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS approved_revision INTEGER,
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS approval_source TEXT,
    ADD COLUMN IF NOT EXISTS request_id TEXT,
    ADD COLUMN IF NOT EXISTS request_hash TEXT,
    ADD COLUMN IF NOT EXISTS target_account_id TEXT,
    ADD COLUMN IF NOT EXISTS container_id TEXT,
    ADD COLUMN IF NOT EXISTS legacy BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`UPDATE publicaciones_instagram SET approved_revision=revision,
    approval_source='legacy_pre_v35' WHERE legacy=TRUE AND status='programada' AND approved_revision IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_publicaciones_request ON publicaciones_instagram(request_id)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS publicacion_eventos (
    id BIGSERIAL PRIMARY KEY, publicacion_id BIGINT NOT NULL REFERENCES publicaciones_instagram(id),
    accion TEXT NOT NULL, revision INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

function createPublications({ pool, igRequest, accountId, publicBaseUrl, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const base = publicBaseUrl.replace(/\/$/, '');
  async function get(id) {
    const r = await pool.query('SELECT * FROM publicaciones_instagram WHERE id=$1', [integer(id)]);
    if (!r.rows.length) throw problem('Publicación no encontrada', 404);
    return r.rows[0];
  }
  async function image(id) {
    const r = await pool.query('SELECT id FROM imagenes_marketing WHERE id=$1', [integer(id, 'image_id')]);
    if (!r.rows.length) throw problem('Imagen no encontrada', 404);
    return `${base}/media/generated/${r.rows[0].id}.jpg`;
  }
  async function create(body) {
    if (!accountId) throw problem('Instagram no está configurado', 503);
    const requestId = key(body.request_id);
    const imageId = integer(body.image_id, 'image_id');
    const caption = text(body.caption ?? '', 2200, 'caption');
    const hash = createHash('sha256').update(JSON.stringify([imageId, caption, accountId])).digest('hex');
    const imageUrl = await image(imageId);
    const r = await pool.query(`INSERT INTO publicaciones_instagram
      (image_id,image_url,caption,status,request_id,request_hash,target_account_id,legacy)
      VALUES ($1,$2,$3,'borrador',$4,$5,$6,FALSE)
      ON CONFLICT (request_id) DO NOTHING RETURNING *`, [imageId,imageUrl,caption,requestId,hash,accountId]);
    const item = r.rows[0] || (await pool.query('SELECT * FROM publicaciones_instagram WHERE request_id=$1',[requestId])).rows[0];
    if (item.request_hash !== hash) throw problem('request_id ya usado con otro contenido',409);
    return item;
  }
  async function createReel(body) {
    const id=integer(body.reel_id,'reel_id'), requestId=key(body.request_id);
    const caption=text(body.caption??'',2200,'caption');
    const hash=createHash('sha256').update(JSON.stringify(['reel',id,caption,accountId])).digest('hex');
    const r=await pool.query(`INSERT INTO publicaciones_instagram
      (reel_id,image_url,caption,status,request_id,request_hash,target_account_id,legacy)
      SELECT id,$2,$3,'borrador',$4,$5,$6,FALSE FROM reels_marketing WHERE id=$1 AND status='lista' AND video_data IS NOT NULL
      ON CONFLICT(request_id) DO NOTHING RETURNING *`,[id,`${base}/media/reels/${id}.mp4`,caption,requestId,hash,accountId]);
    const item=r.rows[0]||(await pool.query('SELECT * FROM publicaciones_instagram WHERE request_id=$1',[requestId])).rows[0];
    if(!item)throw problem('El reel todavía no está listo o fue archivado',409);
    if(item.request_hash!==hash)throw problem('request_id usado para otra pieza',409);
    return item;
  }
  async function approve(id, body) {
    if (body.confirmacion !== true) throw problem('Se requiere confirmación de la pieza final');
    const revision = integer(body.revision, 'revision');
    const r = await pool.query(`WITH changed AS (
      UPDATE publicaciones_instagram SET status='aprobada', approved_revision=revision,
        approved_at=NOW(),approval_source='user_confirmed_via_action',updated_at=NOW()
      WHERE id=$1 AND revision=$2 AND status='borrador' RETURNING *
    ), event AS (INSERT INTO publicacion_eventos(publicacion_id,accion,revision)
      SELECT id,'aprobacion',revision FROM changed)
    SELECT * FROM changed`,[integer(id),revision]);
    if (r.rows.length) return r.rows[0];
    const existing = await get(id);
    if (existing.revision === revision && existing.approved_revision === revision && ['aprobada','programada','procesando','publicando','publicada'].includes(existing.status)) return existing;
    throw problem('La pieza cambió o no está en estado aprobable. Consultá su versión actual.',409);
  }
  async function edit(id, body) {
    const current=await get(id);
    if(current.reel_id)throw problem('Para modificar un reel, creá un nuevo borrador y cancelá el anterior',409);
    const revision = integer(body.revision, 'revision');
    const imageId = integer(body.image_id, 'image_id');
    const imageUrl = await image(imageId);
    const caption = text(body.caption ?? '',2200,'caption');
    const r = await pool.query(`UPDATE publicaciones_instagram SET image_id=$3,image_url=$4,caption=$5,
      revision=revision+1,approved_revision=NULL,approved_at=NULL,approval_source=NULL,
      status='borrador',scheduled_at=NULL,target_account_id=$6,legacy=FALSE,updated_at=NOW()
      WHERE id=$1 AND revision=$2 AND status IN ('borrador','aprobada','programada') RETURNING *`,
    [integer(id),revision,imageId,imageUrl,caption,accountId]);
    if (!r.rows.length) throw problem('La pieza cambió o ya comenzó a publicarse',409);
    return r.rows[0];
  }
  async function schedule(id, body) {
    const revision = integer(body.revision,'revision');
    const date = futureDate(body.scheduled_at);
    const r = await pool.query(`UPDATE publicaciones_instagram SET status='programada',scheduled_at=$3,updated_at=NOW()
      WHERE id=$1 AND revision=$2 AND approved_revision=revision
      AND status IN ('aprobada','programada') RETURNING *`,[integer(id),revision,date]);
    if (!r.rows.length) throw problem('Necesita aprobación vigente o ya comenzó a publicarse',409);
    return r.rows[0];
  }
  async function cancel(id, body) {
    const r = await pool.query(`UPDATE publicaciones_instagram SET status='cancelada',updated_at=NOW()
      WHERE id=$1 AND revision=$2 AND status IN ('borrador','aprobada','programada','cancelada') RETURNING *`,
    [integer(id),integer(body.revision,'revision')]);
    if (!r.rows.length) throw problem('La pieza cambió o ya comenzó a publicarse',409);
    return r.rows[0];
  }
  async function publish(id, revision, dueOnly = false) {
    // One shared atomic claim for the manual path and every cron worker.
    const claim = await pool.query(`UPDATE publicaciones_instagram SET status='procesando',updated_at=NOW()
      WHERE id=$1 AND revision=$2 AND approved_revision=revision
      AND status IN ('aprobada','programada')
      AND (target_account_id=$3 OR legacy=TRUE)
      AND ($4::boolean=FALSE OR (status='programada' AND scheduled_at<=NOW())) RETURNING *`,
    [integer(id),integer(revision,'revision'),accountId,dueOnly]);
    if (!claim.rows.length) {
      const existing = await get(id);
      if (existing.status === 'publicada' && existing.revision === Number(revision)) return existing;
      throw problem('No está aprobada, está ocupada o requiere revisión',409);
    }
    const item = claim.rows[0];
    let stage = 'container';
    try {
      const container = await igRequest(`/${accountId}/media`,{method:'POST',params:item.reel_id?{media_type:'REELS',video_url:item.image_url,caption:item.caption,share_to_feed:true}:{image_url:item.image_url,caption:item.caption}});
      if (!container.id) throw new Error('Instagram no devolvió el contenedor');
      await pool.query("UPDATE publicaciones_instagram SET container_id=$2,updated_at=NOW() WHERE id=$1",[id,container.id]);
      let ready = false;
      for (let i=0;i<(item.reel_id?24:8);i++) {
        const state = await igRequest(`/${container.id}`,{params:{fields:'status_code,status'}});
        if (state.status_code === 'FINISHED') { ready=true; break; }
        if (['ERROR','EXPIRED'].includes(state.status_code)) throw new Error('Instagram rechazó el contenedor');
        if (state.status_code === 'PUBLISHED') throw new Error('El contenedor ya figura publicado; verificar');
        if (i<(item.reel_id?23:7)) await wait(2500);
      }
      if (!ready) throw new Error('El contenedor no terminó a tiempo');
      // Persist intent BEFORE the irreversible API call. A crash cannot trigger an automatic resend.
      const intent = await pool.query(`UPDATE publicaciones_instagram SET status='publicando',updated_at=NOW()
        WHERE id=$1 AND status='procesando' RETURNING id`,[id]);
      if (!intent.rows.length) throw new Error('Se perdió la reserva de la publicación');
      stage = 'publish';
      const result = await igRequest(`/${accountId}/media_publish`,{method:'POST',params:{creation_id:container.id}});
      if (!result.id) throw new Error('Instagram no devolvió el identificador publicado');
      const saved = await pool.query(`UPDATE publicaciones_instagram SET status='publicada',instagram_media_id=$2,
        published_at=NOW(),updated_at=NOW(),error=NULL WHERE id=$1 RETURNING *`,[id,result.id]);
      return saved.rows[0];
    } catch (_) {
      // Do not leak provider errors/tokens. Pre-publication errors also need deliberate recovery.
      const message = stage === 'publish' ? 'Resultado de publicación incierto. Verificar contenedor antes de repetir.' : 'No se pudo preparar la publicación. Revisar contenedor antes de repetir.';
      await pool.query(`UPDATE publicaciones_instagram SET status='revision',error=$2,updated_at=NOW()
        WHERE id=$1 AND status IN ('procesando','publicando')`,[id,message]);
      throw problem(message,502);
    }
  }
  async function reconcile(id) {
    const item = await get(id);
    if (item.status === 'publicada') return item;
    if (!['revision','error'].includes(item.status) || !item.container_id) throw problem('No hay contenedor en estado revisable',409);
    const state = await igRequest(`/${item.container_id}`,{params:{fields:'status_code,status'}});
    if (state.status_code === 'PUBLISHED') {
      const r = await pool.query(`UPDATE publicaciones_instagram SET status='publicada',verified_at=NOW(),
        updated_at=NOW(),error=NULL WHERE id=$1 AND status IN ('revision','error') RETURNING *`,[id]);
      return {publicacion:r.rows[0] || await get(id), verificado_en_instagram:true};
    }
    return {publicacion:item,container_status:state.status_code,requiere_revision:true};
  }
  async function processDue() {
    // Requests have bounded timeouts. Stale work is quarantined, never resent blindly.
    const stale = await pool.query(`UPDATE publicaciones_instagram SET status='revision',error='Proceso interrumpido; verificar contenedor',updated_at=NOW()
      WHERE status IN ('procesando','publicando') AND updated_at < NOW()-INTERVAL '15 minutes' RETURNING id`);
    const due = await pool.query("SELECT id,revision FROM publicaciones_instagram WHERE status='programada' AND scheduled_at<=NOW() ORDER BY scheduled_at,id LIMIT 10");
    const results=[];
    for (const item of due.rows) {
      try { results.push({id:item.id,ok:true,publicacion:await publish(item.id,item.revision,true)}); }
      catch (e) {
        const current = e.status===409 ? await get(item.id) : null;
        const skipped = current && ['procesando','publicando','publicada','cancelada','borrador'].includes(current.status);
        results.push({id:item.id,ok:!!skipped,omitida:!!skipped,error:skipped?undefined:e.message});
      }
    }
    const attention = await pool.query("SELECT COUNT(*)::int AS total FROM publicaciones_instagram WHERE status IN ('revision','error')");
    // Fail on NEW errors; retaining an old review item must not disable the scheduler forever.
    return {ok:!results.some(r=>!r.ok) && stale.rows.length===0,procesadas:results.filter(r=>!r.omitida).length,
      requieren_revision:attention.rows[0].total,resultados:results};
  }
  return {get,create,createReel,approve,edit,schedule,cancel,publish,reconcile,processDue};
}

function registerRoutes(app, deps) {
  const service=createPublications(deps);
  const route=fn=>async(req,res)=>{try {res.json(await fn(req));}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Error interno; consultá el estado antes de repetir'});}};
  app.post('/api/instagram/borradores-reel',route(req=>service.createReel(req.body||{})));
  app.post('/api/instagram/borradores',route(req=>service.create(req.body||{})));
  app.get('/api/instagram/programaciones/:id',route(req=>service.get(req.params.id)));
  app.patch('/api/instagram/programaciones/:id',route(req=>service.edit(req.params.id,req.body||{})));
  app.post('/api/instagram/programaciones/:id/aprobar',route(req=>service.approve(req.params.id,req.body||{})));
  app.post('/api/instagram/programaciones',route(req=>service.schedule(req.body?.publication_id,req.body||{})));
  app.post('/api/instagram/publicar-imagen',route(req=>service.publish(req.body?.publication_id,req.body?.revision)));
  app.post('/api/instagram/programaciones/:id/publicar',route(req=>service.publish(req.params.id,req.body?.revision)));
  app.post('/api/instagram/programaciones/:id/cancelar',route(req=>service.cancel(req.params.id,req.body||{})));
  app.post('/api/instagram/programaciones/:id/verificar',route(req=>service.reconcile(req.params.id)));
  app.post('/api/instagram/generar-y-programar',(_req,res)=>res.status(410).json({error:'Creá la imagen y el borrador, mostralos y registrá la aprobación antes de programar.'}));
  app.get('/api/instagram/programaciones',route(async req=>{
    const limit=Math.min(integer(req.query.limite||25,'limite'),100);
    const before=req.query.before_id?integer(req.query.before_id,'before_id'):null;
    const status=req.query.status||null;
    if (status && !STATES.includes(status)) throw problem('status inválido');
    const r=await deps.pool.query(`SELECT * FROM publicaciones_instagram WHERE ($1::text IS NULL OR status=$1)
      AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT $3`,[status,before,limit]);
    return {publicaciones:r.rows,next_before_id:r.rows.length===limit?r.rows.at(-1).id:null};
  }));
  app.post('/api/instagram/procesar-programadas',async(_req,res)=>{
    try {const r=await service.processDue();res.status(r.ok?200:503).json(r);}
    catch (_) {res.status(503).json({ok:false,error:'Error procesando; consultar estados antes de repetir'});}
  });
  return service;
}
module.exports={migrate,createPublications,registerRoutes,futureDate,STATES};
